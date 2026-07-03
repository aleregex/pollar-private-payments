import { Templates } from './ui/templates.js';
import { Shell, Wallet } from './ui/navigation.js';
import { Transactions } from './ui/transactions.js';
import { NotesTable } from './ui/notes-table.js';
import { Dashboard } from './ui/dashboard.js';
import { updateLastVisit, registerServiceWorker } from './ui/push-notifications.js';

document.addEventListener('DOMContentLoaded', async () => {
    Templates.init();
    Shell.init();
    Wallet.init();
    Transactions.init();
    NotesTable.init();
    Dashboard.init();

    updateLastVisit();
    registerServiceWorker();

    // Restore the LAST provider the user connected with ('pollar' restores the
    // persisted Pollar session without any modal; 'freighter' keeps the old
    // silent reconnect). With nothing stored, never auto-connect — the user
    // picks via the Login button.
    const lastProvider = localStorage.getItem('walletProvider');
    if (lastProvider) {
        Wallet.connect({ auto: true, provider: lastProvider }).catch(() => {});
    }
});
