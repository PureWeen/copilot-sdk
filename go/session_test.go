package copilot

import (
	"sync"
	"testing"
	"time"
)

func TestSession_On(t *testing.T) {
	t.Run("multiple handlers all receive events", func(t *testing.T) {
		session := &Session{
			handlers: make([]sessionHandler, 0),
		}

		var received1, received2, received3 bool
		session.On(func(event SessionEvent) { received1 = true })
		session.On(func(event SessionEvent) { received2 = true })
		session.On(func(event SessionEvent) { received3 = true })

		session.dispatchEvent(SessionEvent{Type: "test"})

		if !received1 || !received2 || !received3 {
			t.Errorf("Expected all handlers to receive event, got received1=%v, received2=%v, received3=%v",
				received1, received2, received3)
		}
	})

	t.Run("unsubscribing one handler does not affect others", func(t *testing.T) {
		session := &Session{
			handlers: make([]sessionHandler, 0),
		}

		var count1, count2, count3 int
		session.On(func(event SessionEvent) { count1++ })
		unsub2 := session.On(func(event SessionEvent) { count2++ })
		session.On(func(event SessionEvent) { count3++ })

		// First event - all handlers receive it
		session.dispatchEvent(SessionEvent{Type: "test"})

		// Unsubscribe handler 2
		unsub2()

		// Second event - only handlers 1 and 3 should receive it
		session.dispatchEvent(SessionEvent{Type: "test"})

		if count1 != 2 {
			t.Errorf("Expected handler 1 to receive 2 events, got %d", count1)
		}
		if count2 != 1 {
			t.Errorf("Expected handler 2 to receive 1 event (before unsubscribe), got %d", count2)
		}
		if count3 != 2 {
			t.Errorf("Expected handler 3 to receive 2 events, got %d", count3)
		}
	})

	t.Run("calling unsubscribe multiple times is safe", func(t *testing.T) {
		session := &Session{
			handlers: make([]sessionHandler, 0),
		}

		var count int
		unsub := session.On(func(event SessionEvent) { count++ })

		session.dispatchEvent(SessionEvent{Type: "test"})

		// Call unsubscribe multiple times - should not panic
		unsub()
		unsub()
		unsub()

		session.dispatchEvent(SessionEvent{Type: "test"})

		if count != 1 {
			t.Errorf("Expected handler to receive 1 event, got %d", count)
		}
	})

	t.Run("handlers are called in registration order", func(t *testing.T) {
		session := &Session{
			handlers: make([]sessionHandler, 0),
		}

		var order []int
		session.On(func(event SessionEvent) { order = append(order, 1) })
		session.On(func(event SessionEvent) { order = append(order, 2) })
		session.On(func(event SessionEvent) { order = append(order, 3) })

		session.dispatchEvent(SessionEvent{Type: "test"})

		if len(order) != 3 || order[0] != 1 || order[1] != 2 || order[2] != 3 {
			t.Errorf("Expected handlers to be called in order [1,2,3], got %v", order)
		}
	})

	t.Run("concurrent subscribe and unsubscribe is safe", func(t *testing.T) {
		session := &Session{
			handlers: make([]sessionHandler, 0),
		}

		var wg sync.WaitGroup
		for i := 0; i < 100; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				unsub := session.On(func(event SessionEvent) {})
				unsub()
			}()
		}
		wg.Wait()

		// Should not panic and handlers should be empty
		session.handlerMutex.RLock()
		count := len(session.handlers)
		session.handlerMutex.RUnlock()

		if count != 0 {
			t.Errorf("Expected 0 handlers after all unsubscribes, got %d", count)
		}
	})
}

func TestSession_IdleFallback(t *testing.T) {
	t.Run("synthesizes session.idle when turn_end arrives without idle", func(t *testing.T) {
		session := &Session{
			handlers:          make([]sessionHandler, 0),
			idleFallbackDelay: 100 * time.Millisecond,
		}

		var mu sync.Mutex
		var events []SessionEventType
		session.On(func(event SessionEvent) {
			mu.Lock()
			events = append(events, event.Type)
			mu.Unlock()
		})

		session.dispatchEvent(SessionEvent{Type: AssistantTurnEnd})

		time.Sleep(200 * time.Millisecond)

		mu.Lock()
		defer mu.Unlock()
		if len(events) != 2 {
			t.Fatalf("Expected 2 events, got %d: %v", len(events), events)
		}
		if events[0] != AssistantTurnEnd {
			t.Errorf("Expected first event to be assistant.turn_end, got %s", events[0])
		}
		if events[1] != SessionIdle {
			t.Errorf("Expected second event to be session.idle, got %s", events[1])
		}
	})

	t.Run("does not synthesize idle when real idle arrives in time", func(t *testing.T) {
		session := &Session{
			handlers:          make([]sessionHandler, 0),
			idleFallbackDelay: 200 * time.Millisecond,
		}

		var mu sync.Mutex
		var events []SessionEventType
		session.On(func(event SessionEvent) {
			mu.Lock()
			events = append(events, event.Type)
			mu.Unlock()
		})

		session.dispatchEvent(SessionEvent{Type: AssistantTurnEnd})
		time.Sleep(50 * time.Millisecond)
		session.dispatchEvent(SessionEvent{Type: SessionIdle})

		// Wait past the original grace period to confirm no extra idle
		time.Sleep(300 * time.Millisecond)

		mu.Lock()
		defer mu.Unlock()
		if len(events) != 2 {
			t.Fatalf("Expected 2 events (turn_end + real idle), got %d: %v", len(events), events)
		}
		if events[1] != SessionIdle {
			t.Errorf("Expected second event to be session.idle, got %s", events[1])
		}
	})

	t.Run("disconnect cancels pending fallback timer", func(t *testing.T) {
		session := &Session{
			handlers:          make([]sessionHandler, 0),
			idleFallbackDelay: 100 * time.Millisecond,
		}

		var mu sync.Mutex
		var events []SessionEventType
		session.On(func(event SessionEvent) {
			mu.Lock()
			events = append(events, event.Type)
			mu.Unlock()
		})

		session.dispatchEvent(SessionEvent{Type: AssistantTurnEnd})

		// Cancel the timer before it fires
		session.cancelIdleFallbackTimer()

		// Wait past the grace period — no synthetic idle should appear
		time.Sleep(200 * time.Millisecond)

		mu.Lock()
		defer mu.Unlock()
		if len(events) != 1 {
			t.Fatalf("Expected 1 event (turn_end only), got %d: %v", len(events), events)
		}
		if events[0] != AssistantTurnEnd {
			t.Errorf("Expected first event to be assistant.turn_end, got %s", events[0])
		}
	})

	t.Run("resets fallback timer on subsequent turn_end", func(t *testing.T) {
		session := &Session{
			handlers:          make([]sessionHandler, 0),
			idleFallbackDelay: 150 * time.Millisecond,
		}

		var mu sync.Mutex
		var events []SessionEventType
		session.On(func(event SessionEvent) {
			mu.Lock()
			events = append(events, event.Type)
			mu.Unlock()
		})

		session.dispatchEvent(SessionEvent{Type: AssistantTurnEnd})
		time.Sleep(100 * time.Millisecond) // within grace period

		// Second turn_end resets the timer
		session.dispatchEvent(SessionEvent{Type: AssistantTurnEnd})
		time.Sleep(100 * time.Millisecond) // 100ms after second turn_end

		mu.Lock()
		eventCount := len(events)
		mu.Unlock()
		// Should only have the two turn_end events so far (timer reset)
		if eventCount != 2 {
			t.Fatalf("Expected 2 events at this point, got %d", eventCount)
		}

		// Wait for the timer to fire
		time.Sleep(100 * time.Millisecond)

		mu.Lock()
		defer mu.Unlock()
		if len(events) != 3 {
			t.Fatalf("Expected 3 events (2 turn_end + 1 synthetic idle), got %d: %v", len(events), events)
		}
		if events[2] != SessionIdle {
			t.Errorf("Expected third event to be session.idle, got %s", events[2])
		}
	})
}
