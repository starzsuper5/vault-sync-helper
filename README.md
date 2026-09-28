# Vault Sync Helper

A mobile-compatible Obsidian helper for TaxBee Notes. It keeps the Markdown sync behavior and adds a simple card-based Notes home plus a Directory view in Obsidian's native left sidebar.

## TaxBee Notes Home

- Folder button + `Search notes...` + yellow `New` button
- Current directory label (`Default` for the sync root)
- Note cards with title and content preview
- One column on phones, two columns on larger screens
- Tap a card to edit it with Obsidian's native Markdown editor
- Full-text search is limited to the TaxBee sync folder
- New notes are created in the currently selected TaxBee directory

## Directory sidebar

The native left sidebar is reused so mobile swipe gestures still work and Obsidian's Settings entry remains available. The sidebar shows only the TaxBee directory tree. `Default` represents notes directly under the TaxBee sync root.

The `...` menu supports creating a note/folder and expanding/collapsing the tree. Destructive folder actions are intentionally not exposed here.

## Sync isolation

Only Markdown notes inside the configured TaxBee sync folder can be uploaded. Notes elsewhere in the vault remain local. Existing revision/conflict handling and the server serial-sync gate remain unchanged.

## Install with BRAT

1. Install and enable **BRAT** from Obsidian Community Plugins.
2. In BRAT, choose **Add Beta Plugin**.
3. Add this repository.
4. Enable **Vault Sync Helper** under Community Plugins.
5. In TaxBee, open **Notes Sync** and create a one-time pairing code.
6. In Obsidian, open **Settings → Vault Sync Helper**, enter the portal address and pairing code, then tap **Connect**.

New installations use `TaxBee Notes` as the default sync folder. Existing installations keep their previously configured sync folder.
