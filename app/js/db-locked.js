// Shared handling for the "local database is locked by another tab/window"
// condition. The message text is produced by the Rust storage worker and
// surfaced verbatim — this module only detects it and renders a blocking modal.

export function isDbLockedError(message) {
    return typeof message === 'string'
        && message.includes("Another tab or window is using this app's local database");
}

let shown = false;

// Show a blocking, top-most modal carrying the backend-provided message and a
// reload button. Injected into the DOM so every page behaves identically without
// per-page markup. Idempotent: only the first call renders.
export function showDbLockedModal(message) {
    if (shown || typeof document === 'undefined') return;
    shown = true;

    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/50 px-4 backdrop-blur-sm';

    const card = document.createElement('div');
    card.className = 'mx-auto max-w-md rounded-xl border border-slate-200 bg-white p-8 text-center shadow-2xl';

    const eyebrow = document.createElement('p');
    eyebrow.className = 'text-[11px] font-semibold uppercase tracking-[0.34em] text-amber-600';
    eyebrow.textContent = 'App already open';

    const title = document.createElement('h2');
    title.className = 'mt-3 text-xl font-semibold tracking-tight text-slate-900';
    title.textContent = 'Another tab is using this app';

    const msg = document.createElement('p');
    msg.className = 'mt-4 text-sm leading-6 text-slate-600';
    msg.textContent = String(message ?? '');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mt-6 inline-flex w-full items-center justify-center rounded-lg bg-brand-700 px-5 py-3 text-sm font-semibold text-white shadow-md shadow-brand-700/20 transition hover:brightness-110';
    btn.textContent = 'Reload this page';
    btn.addEventListener('click', () => window.location.reload());

    card.append(eyebrow, title, msg, btn);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
}
