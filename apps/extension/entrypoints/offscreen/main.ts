/**
 * The offscreen document, serving both the things that need a page: the
 * clipboard, which is read on request, and the microphone, which is held for
 * as long as the worker says to hold it. The document being open no longer
 * means the microphone is on, because the clipboard may be why it is up.
 */
import { start, stop } from '@/src/engine/offscreen/listen';
import { onMessage } from '@/src/messaging';

const sink = document.getElementById('sink') as HTMLTextAreaElement;

/**
 * `execCommand('paste')` is what an offscreen document has:
 * `navigator.clipboard.readText()` wants a focused page and a user gesture,
 * and there is neither here. The textarea is emptied on the way out, so what
 * was pasted does not sit in the DOM between reads.
 */
onMessage('readClipboard', () => {
  sink.value = '';
  try {
    sink.focus();
    const ok = document.execCommand('paste');
    return { text: ok ? sink.value : '' };
  } catch {
    return { text: '' };
  } finally {
    sink.value = '';
  }
});

chrome.runtime.onMessage.addListener((msg: { type?: string } | undefined) => {
  if (msg?.type === 'carat-listen-start') void start();
  if (msg?.type === 'carat-listen-stop') void stop();
});
