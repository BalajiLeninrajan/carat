import type { ControlRole } from '@carat/shared';
import { COMPOSER_NAME } from '@carat/shared';
import { isDetails, isInput, isSelect, isTextArea } from '../dom/tags';
import { roleOf, toggleState } from '../interact';

/**
 * A name that pays, sends, deletes or commits an order. The model is asked to
 * set `irreversible` itself; this is the backstop, read off the control's own
 * name so a chip can arm even when the model forgets.
 */
const RISKY =
  /\b(?:pay|paying|payment|purchase|buy|place (?:the )?order|checkout|check out|send|submit (?:order|payment)|delete|remove|unsubscribe|sign out|log ?out|confirm (?:booking|order|payment|purchase))\b/i;

export function isRiskyName(name: string): boolean {
  return RISKY.test(name);
}

const TEXT_INPUT_TYPES = new Set(['', 'text', 'email', 'tel', 'url', 'number', 'date', 'datetime-local', 'month', 'week', 'time']);
const ARIA_CONTROL_ROLE: Record<string, ControlRole> = {
  button: 'button',
  link: 'link',
  checkbox: 'checkbox',
  radio: 'radio',
  switch: 'switch',
  slider: 'slider',
  tab: 'tab',
  menuitem: 'menuitem',
  menuitemcheckbox: 'checkbox',
  menuitemradio: 'radio',
  option: 'option',
  treeitem: 'option',
  textbox: 'textbox',
  searchbox: 'searchbox',
  combobox: 'combobox',
  listbox: 'select',
  spinbutton: 'textbox',
};

/**
 * Which of the outline's roles a control plays, or null when the element is
 * not operable. Text fields, which `roleOf` does not describe, are read here;
 * everything else defers to the interact enumerator's own mapping so the
 * outline and the perform path agree on what a thing is.
 */
export function controlRoleOf(el: Element): ControlRole | null {
  const aria = el.getAttribute('role')?.toLowerCase();
  if (aria && aria in ARIA_CONTROL_ROLE) return ARIA_CONTROL_ROLE[aria]!;
  if (isInput(el)) {
    const type = el.type.toLowerCase();
    if (type === 'search') return 'searchbox';
    if (type === 'password') return 'textbox';
    if (TEXT_INPUT_TYPES.has(type)) return el.hasAttribute('list') ? 'combobox' : 'textbox';
  }
  if (isTextArea(el)) return 'textbox';
  if (isEditable(el)) return 'textbox';
  if (isSelect(el)) return 'select';
  const role = roleOf(el);
  switch (role) {
    case null:
      return null;
    case 'disclosure':
      // A summary or an aria-expanded toggle: one click, like a button.
      return 'button';
    case 'select':
      return 'select';
    default:
      return role;
  }
}

/**
 * A field the user writes in: a textarea or an editor named for a comment, a
 * reply, a message or a post, or any contenteditable sitting in a composer's
 * furniture, a formatting toolbar or a submit button beside it. The name
 * alone is not enough for the editors that carry no name at all, which is
 * most of them.
 */
export function isComposerField(el: Element, role: ControlRole, name: string): boolean {
  if (role !== 'textbox') return false;
  const multiline = isTextArea(el) || isEditable(el) || el.getAttribute('aria-multiline') === 'true';
  if (!multiline) return false;
  const said = [name, el.getAttribute('placeholder') ?? '', el.getAttribute('aria-label') ?? ''];
  if (said.some((text) => COMPOSER_NAME.test(text))) return true;
  return isEditable(el) && hasComposerFurniture(el);
}

function hasComposerFurniture(el: Element): boolean {
  const scope = el.closest('form,[role="form"],[class*="composer" i],[class*="editor" i]') ?? el.parentElement;
  return scope?.querySelector('[role="toolbar"],button[type="submit"],input[type="submit"]') != null;
}

export function isEditable(el: Element): boolean {
  const attr = el.getAttribute('contenteditable');
  return attr === '' || attr?.toLowerCase() === 'true' || attr?.toLowerCase() === 'plaintext-only';
}

/**
 * `required checked expanded selected disabled`, whichever apply, in a fixed
 * order so the same control reads the same way twice.
 */
export function stateOf(el: Element, role: ControlRole): string {
  const out: string[] = [];
  const aria = (name: string): string | null => el.getAttribute(name);
  const required = isInput(el) || isTextArea(el) || isSelect(el) ? el.required : aria('aria-required') === 'true';
  if (required) out.push('required');
  const checkable = role === 'checkbox' || role === 'switch' || role === 'radio';
  if (aria('aria-checked') === 'mixed') out.push('mixed');
  else {
    const toggle = toggleState(el);
    if (toggle === 'on') out.push('checked');
    else if (toggle === 'off' && checkable) out.push('unchecked');
  }
  const expanded = aria('aria-expanded') ?? (isDetails(el.parentElement) && el.tagName.toLowerCase() === 'summary' ? String(el.parentElement.open) : null);
  if (expanded === 'true') out.push('expanded');
  else if (expanded === 'false') out.push('collapsed');
  if (aria('aria-selected') === 'true' || aria('aria-current') === 'page') out.push('selected');
  if (isDisabled(el)) out.push('disabled');
  if (aria('aria-invalid') === 'true') out.push('invalid');
  if ((isInput(el) || isTextArea(el)) && el.readOnly) out.push('readonly');
  return out.join(' ');
}

export function isDisabled(el: Element): boolean {
  if ('disabled' in el && (el as { disabled: unknown }).disabled === true) return true;
  if (el.getAttribute('aria-disabled') === 'true') return true;
  return el.closest('fieldset[disabled],[aria-disabled="true"],[inert]') !== null;
}
