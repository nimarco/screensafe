/**
 * Yield to the event loop without using a timer.
 *
 * `setTimeout(fn, 0)` is the obvious way to let encoder callbacks drain between
 * chunks, but browsers clamp timers in backgrounded tabs — to ~1/second, and
 * after a few minutes of intensive throttling as little as 1/minute. An export
 * loop that yields a hundred times then takes minutes instead of seconds, and
 * users absolutely do switch tabs while a long export runs.
 *
 * MessageChannel messages are ordinary tasks and are not subject to timer
 * throttling, so they keep a long-running pipeline moving at full speed in a
 * hidden tab.
 */
let channel: MessageChannel | null = null;
const waiting: Array<() => void> = [];

export function yieldToLoop(): Promise<void> {
  if (typeof MessageChannel === 'undefined') {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!channel) {
    channel = new MessageChannel();
    channel.port1.onmessage = () => {
      const next = waiting.shift();
      next?.();
    };
  }
  return new Promise<void>((resolve) => {
    waiting.push(resolve);
    channel!.port2.postMessage(0);
  });
}
