export function fillSelect(el: HTMLSelectElement, value: string): boolean {
  el.focus();
  el.value = value;
  if (el.value !== value) {
    const wanted = value.trim().toLowerCase();
    const byText = Array.from(el.options).find((o) => o.text.trim().toLowerCase() === wanted);
    if (!byText) return false;
    el.value = byText.value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}
