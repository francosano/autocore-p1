// TARGET: autocore-p1-extension/src/selectors.ts
// ═══════════════════════════════════════════════════════════════════════════
// ALL Facebook DOM selectors live here. Facebook's markup changes constantly
// and its class names are obfuscated/rotated, so we prefer STABLE signals —
// ARIA roles, aria-labels, data-testids, href patterns — over CSS classes.
// When FB changes its interface, this is the ONE file to update (the content
// scripts import from here and never hard-code a selector).
//
// Each entry is a list of candidate selectors tried in order (first match
// wins), so we can add a new variant above an old one without a rewrite.
// ═══════════════════════════════════════════════════════════════════════════

export const SEL = {
  // ── Inbox thread list ────────────────────────────────────────────────────
  // A scrollable list of conversation rows on the Marketplace inbox.
  threadList: [
    'div[aria-label="Chats"][role="grid"]',
    'div[role="grid"]',
    'div[aria-label*="conversation" i][role="list"]',
  ],
  // Individual conversation row (link to the thread).
  threadRow: [
    'a[href*="/marketplace/t/"]',
    'div[role="row"] a[href*="/t/"]',
    'a[role="link"][href*="/messages/t/"]',
  ],
  // Within a row: the buyer/display name and the last-message preview.
  threadName: [
    'span[dir="auto"] span',
    'span[dir="auto"]',
  ],
  threadPreview: [
    'span[dir="auto"]:last-of-type',
  ],

  // ── Open thread (message view) ───────────────────────────────────────────
  // The container of the currently open conversation's messages.
  messageScroller: [
    'div[role="main"] div[aria-label*="Messages" i]',
    'div[aria-label*="Mensajes" i]',
    'div[role="main"]',
  ],
  // A single message bubble/row. FB marks rows with role="row" inside the
  // message list; the text lives in a dir="auto" span.
  messageRow: [
    'div[role="row"]',
    'div[data-testid="message-container"]',
  ],
  messageText: [
    'div[dir="auto"]',
    'span[dir="auto"]',
  ],
  // Heuristic for outbound vs inbound: FB aligns your own messages and often
  // labels them "You sent"/"Enviaste". These aria-label fragments are checked
  // case-insensitively by the content script.
  outboundAriaHints: ['you sent', 'enviaste', 'has enviado'],

  // The listing title shown in a Marketplace thread header (buyer is asking
  // about this vehicle).
  threadListingTitle: [
    'div[role="main"] a[href*="/marketplace/item/"]',
    'a[href*="/marketplace/item/"]',
  ],

  // ── Composer (reply box) ─────────────────────────────────────────────────
  composer: [
    'div[aria-label="Message"][contenteditable="true"]',
    'div[aria-label*="Mensaje" i][contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
  ],
  sendButton: [
    'div[aria-label="Press enter to send"][role="button"]',
    'div[aria-label*="Send" i][role="button"]',
    'div[aria-label*="Enviar" i][role="button"]',
  ],

  // ── Listing publisher (create/vehicle form) ──────────────────────────────
  // Vehicle create form fields. FB uses generic label text; match by the
  // field's aria-label / adjacent label text (checked case-insensitively).
  publishTitleLabels: ['title', 'título', 'titulo'],
  publishPriceLabels: ['price', 'precio'],
  publishDescriptionLabels: ['description', 'descripción', 'descripcion'],
  // Generic input/textarea/contenteditable resolvers used with the labels.
  publishTextInput: [
    'input[type="text"]',
    'input:not([type])',
    'div[contenteditable="true"][role="textbox"]',
    'textarea',
  ],
} as const;

export type SelectorGroup = keyof typeof SEL;
