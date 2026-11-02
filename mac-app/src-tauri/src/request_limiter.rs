use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

pub const DEFAULT_CONCURRENCY: usize = 24;
pub const MIN_CONCURRENCY: usize = 6;
pub const MAX_CONCURRENCY: usize = 64;

struct State {
    limit: usize,
    active: usize,
}

/// One app-wide admission gate. Lowering never cancels in-flight requests: new
/// requests wait until the active count falls below the new limit.
pub struct RequestLimiter {
    state: Mutex<State>,
    changed: Notify,
}

impl Default for RequestLimiter {
    fn default() -> Self {
        Self {
            state: Mutex::new(State { limit: DEFAULT_CONCURRENCY, active: 0 }),
            changed: Notify::new(),
        }
    }
}

impl RequestLimiter {
    pub fn set_limit(&self, limit: usize) -> Result<(), String> {
        if !(MIN_CONCURRENCY..=MAX_CONCURRENCY).contains(&limit) {
            return Err("同时最多发几个请求（所有书合计）必须是 6–64".into());
        }
        self.state.lock().unwrap().limit = limit;
        self.changed.notify_waiters();
        Ok(())
    }

    pub async fn acquire(self: &Arc<Self>) -> RequestPermit {
        loop {
            // Create before checking state: notify_waiters also wakes Notified
            // futures created but not yet polled, so a release cannot be lost.
            let changed = self.changed.notified();
            {
                let mut state = self.state.lock().unwrap();
                if state.active < state.limit {
                    state.active += 1;
                    return RequestPermit { limiter: Arc::clone(self) };
                }
            }
            changed.await;
        }
    }
}

/// Keep this inside the blocking HTTP closure, through response-body decoding.
/// Cancellation of the async caller must not release a still-running request.
pub struct RequestPermit {
    limiter: Arc<RequestLimiter>,
}

impl Drop for RequestPermit {
    fn drop(&mut self) {
        self.limiter.state.lock().unwrap().active -= 1;
        self.limiter.changed.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::task::{Context, Poll, Wake, Waker};

    fn limiter(limit: usize) -> Arc<RequestLimiter> {
        let limiter = Arc::new(RequestLimiter::default());
        limiter.set_limit(limit).unwrap();
        limiter
    }

    #[derive(Default)]
    struct WakeCount(AtomicUsize);
    impl Wake for WakeCount {
        fn wake(self: Arc<Self>) { self.wake_by_ref(); }
        fn wake_by_ref(self: &Arc<Self>) { self.0.fetch_add(1, Ordering::SeqCst); }
    }

    #[test]
    fn accepts_entire_range_and_defaults_to_24() {
        let limiter = RequestLimiter::default();
        assert_eq!(limiter.state.lock().unwrap().limit, 24);
        for limit in 6..=64 { limiter.set_limit(limit).unwrap(); }
        for limit in [0, 5, 65, usize::MAX] { assert!(limiter.set_limit(limit).is_err()); }
        assert_eq!(limiter.state.lock().unwrap().limit, 64);
    }

    #[test]
    fn several_engines_and_reader_share_one_cap() {
        tauri::async_runtime::block_on(async {
            let limiter = limiter(6);
            let active = Arc::new(AtomicUsize::new(0));
            let peak = Arc::new(AtomicUsize::new(0));
            let mut tasks = Vec::new();
            // Four engines, the reader and the panel all use the same gate.
            for _window in 0..6 {
                for _request in 0..16 {
                    let limiter = Arc::clone(&limiter);
                    let active = Arc::clone(&active);
                    let peak = Arc::clone(&peak);
                    tasks.push(tauri::async_runtime::spawn(async move {
                        let _permit = limiter.acquire().await;
                        let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(count, Ordering::SeqCst);
                        assert!(count <= 6);
                        for _ in 0..8 { tokio::task::yield_now().await; }
                        active.fetch_sub(1, Ordering::SeqCst);
                    }));
                }
            }
            for task in tasks { task.await.unwrap(); }
            assert!(peak.load(Ordering::SeqCst) > 1);
            assert_eq!(active.load(Ordering::SeqCst), 0);
            assert_eq!(limiter.state.lock().unwrap().active, 0);
        });
    }

    #[test]
    fn lowering_waits_for_existing_requests_to_drain() {
        tauri::async_runtime::block_on(async {
            let limiter = limiter(12);
            let mut permits = Vec::new();
            for _ in 0..12 { permits.push(limiter.acquire().await); }
            limiter.set_limit(6).unwrap();
            assert_eq!(limiter.state.lock().unwrap().active, 12);
            let wake = Arc::new(WakeCount::default());
            let waker = Waker::from(Arc::clone(&wake));
            let mut cx = Context::from_waker(&waker);
            let mut next = Box::pin(limiter.acquire());
            assert!(next.as_mut().poll(&mut cx).is_pending());
            for _ in 0..6 {
                drop(permits.pop());
                assert!(next.as_mut().poll(&mut cx).is_pending());
            }
            // At exactly six active requests there is still no free slot.
            assert_eq!(limiter.state.lock().unwrap().active, 6);
            drop(permits.pop());
            let Poll::Ready(permit) = next.as_mut().poll(&mut cx) else { panic!("slot not released") };
            assert_eq!(limiter.state.lock().unwrap().active, 6);
            assert!(wake.0.load(Ordering::SeqCst) > 0);
            drop(permit);
            drop(permits);
            assert_eq!(limiter.state.lock().unwrap().active, 0);
        });
    }

    #[test]
    fn raising_wakes_queued_requests_and_cancelled_waiters_take_no_slot() {
        tauri::async_runtime::block_on(async {
            let limiter = limiter(6);
            let mut permits = Vec::new();
            for _ in 0..6 { permits.push(limiter.acquire().await); }
            let wake = Arc::new(WakeCount::default());
            let waker = Waker::from(Arc::clone(&wake));
            let mut cx = Context::from_waker(&waker);
            let mut cancelled = Box::pin(limiter.acquire());
            assert!(cancelled.as_mut().poll(&mut cx).is_pending());
            drop(cancelled);
            let mut next = Box::pin(limiter.acquire());
            assert!(next.as_mut().poll(&mut cx).is_pending());
            limiter.set_limit(8).unwrap();
            assert!(wake.0.load(Ordering::SeqCst) > 0);
            let Poll::Ready(permit) = next.as_mut().poll(&mut cx) else { panic!("increase did not unblock") };
            assert_eq!(limiter.state.lock().unwrap().active, 7);
            drop(permit);
            drop(permits);
        });
    }

    #[test]
    fn cancelling_the_caller_keeps_the_blocking_http_slot() {
        let limiter = limiter(6);
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (finished_tx, finished_rx) = std::sync::mpsc::channel();
        let mut call = Box::pin(async {
            let permit = limiter.acquire().await;
            tauri::async_runtime::spawn_blocking(move || {
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                drop(permit);
                finished_tx.send(()).unwrap();
            }).await.unwrap();
        });
        let waker = Waker::from(Arc::new(WakeCount::default()));
        let mut cx = Context::from_waker(&waker);
        assert!(call.as_mut().poll(&mut cx).is_pending());
        started_rx.recv().unwrap();
        drop(call);
        assert_eq!(limiter.state.lock().unwrap().active, 1);
        release_tx.send(()).unwrap();
        finished_rx.recv().unwrap();
        assert_eq!(limiter.state.lock().unwrap().active, 0);
    }

    #[test]
    fn errors_and_panics_release_permits() {
        let limiter = limiter(6);
        let fail = || -> Result<(), &'static str> {
            let _permit = tauri::async_runtime::block_on(limiter.acquire());
            Err("HTTP/body error")
        };
        assert!(fail().is_err());
        assert_eq!(limiter.state.lock().unwrap().active, 0);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _permit = tauri::async_runtime::block_on(limiter.acquire());
            panic!("blocking HTTP panic");
        }));
        assert!(result.is_err());
        assert_eq!(limiter.state.lock().unwrap().active, 0);
    }
}
