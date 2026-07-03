/**
 * React island hosting Pollar's official UI (login modal & friends).
 *
 * The app is vanilla JS + WASM, not React — but the official Pollar login
 * modal (Google OAuth / email OTP screens, branding from the Dashboard) ships
 * in `@pollar/react`. We mount a minimal React root whose only job is to
 * render `<PollarProvider>` (which internally mounts the modals) around the
 * SAME `PollarClient` instance the rest of the app uses (wallet-pollar.js),
 * and expose `openLoginModal()` to the vanilla code.
 *
 * Written with `React.createElement` (no JSX) so the existing esbuild hook
 * needs no loader configuration.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { PollarProvider, usePollar } from '@pollar/react';
import { getPollarClient } from './wallet-pollar.js';

// Copied to /js/pollar.css by the Trunk build hook (see Trunk.toml).
const CSS_HREF = './js/pollar.css';

let mounted = false;
let openLoginModalFn = null;
let readyResolvers = [];

function ensureCss() {
    if (document.querySelector('link[data-pollar-css]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_HREF;
    link.setAttribute('data-pollar-css', '1');
    document.head.appendChild(link);
}

/** Invisible component that exports the provider context to vanilla JS. */
function Bridge() {
    const pollar = usePollar();
    React.useEffect(() => {
        openLoginModalFn = pollar.openLoginModal;
        readyResolvers.splice(0).forEach((resolve) => resolve());
    });
    return null;
}

/**
 * Mount the Pollar provider + modals once. Resolves when `openLoginModal`
 * is available. Safe to call multiple times.
 */
export function ensurePollarModalMounted() {
    if (openLoginModalFn) return Promise.resolve();
    if (!mounted) {
        mounted = true;
        ensureCss();
        const host = document.createElement('div');
        host.id = 'pollar-react-root';
        document.body.appendChild(host);
        createRoot(host).render(
            React.createElement(
                PollarProvider,
                { client: getPollarClient() },
                React.createElement(Bridge),
            ),
        );
    }
    return new Promise((resolve) => readyResolvers.push(resolve));
}

/** Open the official Pollar login modal (Google / email OTP per Dashboard config). */
export async function openPollarLoginModal() {
    await ensurePollarModalMounted();
    openLoginModalFn();
}

/**
 * Resolves when the login modal is dismissed (its `.pollar-overlay` leaves the
 * DOM after having been shown). Used to cancel the connect flow when the user
 * closes the modal without authenticating — the SDK exposes no close event, so
 * we watch the React host. Never resolves if the modal never opened.
 */
export function waitForLoginModalClosed() {
    return new Promise((resolve) => {
        const host = document.getElementById('pollar-react-root');
        if (!host) return;
        let seen = !!host.querySelector('.pollar-overlay');
        const observer = new MutationObserver(() => {
            const open = !!host.querySelector('.pollar-overlay');
            if (open) {
                seen = true;
            } else if (seen) {
                observer.disconnect();
                resolve();
            }
        });
        observer.observe(host, { childList: true, subtree: true });
    });
}
