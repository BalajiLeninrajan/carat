import { onMessage } from '@/src/messaging';

const sink = document.getElementById('sink') as HTMLTextAreaElement;

/**
 * The one thing this page does. `execCommand('paste')` is what an offscreen
 * document has: `navigator.clipboard.readText()` wants a focused page and a
 * user gesture, and there is neither here. The textarea is emptied on the way
 * out, so what was pasted does not sit in the DOM between reads.
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
