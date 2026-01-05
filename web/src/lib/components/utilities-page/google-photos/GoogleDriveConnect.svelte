<script lang="ts">
  import { onMount } from 'svelte';
  import { googlePhotosImportStore, type GoogleDriveFile } from '$lib/stores/google-photos-import.store';
  import { Button, Checkbox } from '@immich/ui';
  import byteSize from 'byte-size';

  interface Props {
    onConnect?: () => void;
    onDisconnect?: () => void;
  }

  let { onConnect, onDisconnect }: Props = $props();

  let isCheckingStatus = $state(true);
  let isConnecting = $state(false);
  let isLoadingFiles = $state(false);
  let connectionError = $state<string | null>(null);
  let lastRefresh = $state<Date | null>(null);
  let nextRefreshIn = $state(60);
  let refreshInterval: ReturnType<typeof setInterval> | null = null;
  let countdownInterval: ReturnType<typeof setInterval> | null = null;

  let storeValue = $state<typeof $googlePhotosImportStore>($googlePhotosImportStore);

  $effect(() => {
    const unsubscribe = googlePhotosImportStore.subscribe((v) => {
      storeValue = v;
    });
    return unsubscribe;
  });

  // Auto-refresh every 60 seconds when connected but no files found
  $effect(() => {
    if (storeValue.isGoogleDriveConnected && takeoutFiles.length === 0 && !isLoadingFiles) {
      // Start auto-refresh
      refreshInterval = setInterval(async () => {
        await loadDriveFiles();
      }, 60000);

      // Countdown timer
      nextRefreshIn = 60;
      countdownInterval = setInterval(() => {
        nextRefreshIn = Math.max(0, nextRefreshIn - 1);
      }, 1000);

      return () => {
        if (refreshInterval) clearInterval(refreshInterval);
        if (countdownInterval) clearInterval(countdownInterval);
      };
    } else {
      // Clear intervals when files found or disconnected
      if (refreshInterval) clearInterval(refreshInterval);
      if (countdownInterval) clearInterval(countdownInterval);
    }
  });

  // Check connection status on mount
  onMount(async () => {
    try {
      const response = await fetch('/api/google-photos/google-drive/status');
      if (response.ok) {
        const { connected } = await response.json();
        if (connected) {
          googlePhotosImportStore.setGoogleDriveConnected(true);
          await loadDriveFiles();
        }
      }
    } catch (error) {
      console.error('Failed to check connection status:', error);
    } finally {
      isCheckingStatus = false;
    }
  });

  // Filter for Takeout ZIP files - must start with "takeout" and be a zip
  const takeoutFiles = $derived(
    storeValue.driveFiles.filter(
      (f) =>
        f.name.toLowerCase().startsWith('takeout') &&
        (f.name.toLowerCase().endsWith('.zip') ||
          f.mimeType === 'application/zip' ||
          f.mimeType === 'application/x-zip-compressed')
    )
  );

  async function connectGoogleDrive() {
    isConnecting = true;
    connectionError = null;

    try {
      // Get the OAuth URL from the server
      const response = await fetch('/api/google-photos/google-drive/auth', {
        method: 'POST',
      });

      if (!response.ok) {
        const errorText = await response.text();
        // Try to parse as JSON error message
        try {
          const errorJson = JSON.parse(errorText);
          throw new Error(errorJson.message || errorText);
        } catch {
          throw new Error(errorText || 'Failed to connect to Google Drive');
        }
      }

      const data = await response.json();

      if (!data.authUrl) {
        throw new Error('No authorization URL received from server');
      }

      // Redirect to Google OAuth
      window.location.href = data.authUrl;
    } catch (error) {
      console.error('Failed to connect:', error);
      connectionError = error instanceof Error ? error.message : 'Failed to connect to Google Drive. Please try again.';
      isConnecting = false;
    }
  }

  async function disconnectGoogleDrive() {
    try {
      await fetch('/api/google-photos/google-drive/auth', { method: 'DELETE' });
      googlePhotosImportStore.setGoogleDriveConnected(false);
      googlePhotosImportStore.setDriveFiles([]);
      googlePhotosImportStore.deselectAllDriveFiles();
      onDisconnect?.();
    } catch (error) {
      console.error('Failed to disconnect:', error);
    }
  }

  async function loadDriveFiles() {
    isLoadingFiles = true;

    try {
      // Search for Takeout files in Drive
      const response = await fetch('/api/google-photos/google-drive/files?query=takeout');

      if (!response.ok) {
        throw new Error('Failed to load files');
      }

      const data = await response.json();
      const files: GoogleDriveFile[] = data.files || [];
      googlePhotosImportStore.setDriveFiles(files);
      lastRefresh = new Date();
      nextRefreshIn = 60; // Reset countdown
    } catch (error) {
      console.error('Failed to load files:', error);
      googlePhotosImportStore.setError('Failed to load files from Google Drive');
    } finally {
      isLoadingFiles = false;
    }
  }

  function toggleFile(fileId: string) {
    googlePhotosImportStore.toggleDriveFile(fileId);
  }

  function selectAll() {
    googlePhotosImportStore.selectAllDriveFiles();
  }

  function deselectAll() {
    googlePhotosImportStore.deselectAllDriveFiles();
  }

  function formatDate(dateString: string) {
    return new Date(dateString).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }
</script>

<div class="drive-connect-container">
  <div class="header">
    <div class="icon">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 87.3 78" class="drive-logo">
        <path d="M6.6 66.85l3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8H0c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/>
        <path d="M43.65 25L29.9 1.2c-1.35.8-2.5 1.9-3.3 3.3L1.2 52.35c-.8 1.4-1.2 2.95-1.2 4.5h27.5z" fill="#00ac47"/>
        <path d="M73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75L86.1 57.1c.8-1.4 1.2-2.95 1.2-4.5H59.85L73.55 76.8z" fill="#ea4335"/>
        <path d="M43.65 25L57.4 1.2C56.05.4 54.5 0 52.9 0H34.4c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d"/>
        <path d="M59.85 52.6h27.5c0-1.55-.4-3.1-1.2-4.5L73.55 26.8l-3.85-6.65c-.8-1.4-1.95-2.5-3.3-3.3L43.65 25l16.2 27.6z" fill="#2684fc"/>
        <path d="M73.4 26.85L43.65 25 27.5 52.6h32.35l13.55 23.8c1.35-.8 2.5-1.9 3.3-3.3l3.85-6.65L73.4 26.85z" fill="#ffba00"/>
      </svg>
    </div>
    <div class="text">
      <h3>Google Drive Import</h3>
      <p>
        {#if storeValue.isGoogleDriveConnected}
          Auto-import Takeout files from your Google Drive
        {:else}
          Connect to import Takeout files directly from Drive
        {/if}
      </p>
    </div>
  </div>

  {#if isCheckingStatus}
    <div class="checking-status">
      <span class="spinner"></span>
      <span>Checking connection status...</span>
    </div>
  {:else if !storeValue.isGoogleDriveConnected}
    <div class="connect-section">
      <p class="connect-description">
        If you selected "Add to Drive" in Google Takeout, your export files will appear here automatically.
      </p>

      {#if connectionError}
        <div class="error-message">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" />
          </svg>
          <span>{connectionError}</span>
          <button onclick={() => connectionError = null}>Dismiss</button>
        </div>
      {/if}

      <Button onclick={connectGoogleDrive} color="primary" disabled={isConnecting}>
        {#if isConnecting}
          <span class="spinner"></span>
          Connecting...
        {:else}
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-5 h-5 mr-2">
            <path fill-rule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clip-rule="evenodd" />
          </svg>
          Connect Google Drive
        {/if}
      </Button>
    </div>
  {:else}
    <div class="connected-section">
      <div class="connected-status">
        <span class="status-badge">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd" />
          </svg>
          Connected
        </span>
        <button class="disconnect-btn" onclick={disconnectGoogleDrive}>Disconnect</button>
      </div>

      {#if isLoadingFiles}
        <div class="scanning-drive">
          <div class="scanning-animation">
            <span class="spinner large"></span>
          </div>
          <div class="scanning-text">
            <h4>Scanning Google Drive</h4>
            <p>Looking for Google Takeout files...</p>
          </div>
        </div>
      {:else if takeoutFiles.length === 0}
        <div class="no-files">
          <div class="waiting-icon">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h4>Waiting for Takeout export...</h4>
          <p>No Takeout files found in your Google Drive yet.</p>
          <p class="hint">
            Google Takeout exports can take several hours (or even days for large libraries).
            We'll automatically check every minute for new files.
          </p>
          <div class="auto-refresh-status">
            <span class="refresh-indicator"></span>
            <span>Auto-refreshing in {nextRefreshIn}s</span>
            {#if lastRefresh}
              <span class="last-check">Last checked: {lastRefresh.toLocaleTimeString()}</span>
            {/if}
          </div>
          <Button onclick={loadDriveFiles} size="sm" disabled={isLoadingFiles}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4 mr-1">
              <path fill-rule="evenodd" d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H3.989a.75.75 0 00-.75.75v4.242a.75.75 0 001.5 0v-2.43l.31.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm1.23-3.723a.75.75 0 00.219-.53V2.929a.75.75 0 00-1.5 0V5.36l-.31-.31A7 7 0 003.239 8.188a.75.75 0 101.448.389A5.5 5.5 0 0113.89 6.11l.311.31h-2.432a.75.75 0 000 1.5h4.243a.75.75 0 00.53-.219z" clip-rule="evenodd" />
            </svg>
            Check Now
          </Button>
        </div>
      {:else}
        <div class="file-list">
          <div class="file-list-header">
            <h4>Found {takeoutFiles.length} Takeout file{takeoutFiles.length === 1 ? '' : 's'}</h4>
            <div class="selection-actions">
              <button class="link-btn" onclick={selectAll}>Select all</button>
              <span class="separator">|</span>
              <button class="link-btn" onclick={deselectAll}>Deselect all</button>
            </div>
          </div>

          <ul>
            {#each takeoutFiles as file}
              <li>
                <label class="file-row">
                  <Checkbox
                    checked={storeValue.selectedDriveFiles.includes(file.id)}
                    onchange={() => toggleFile(file.id)}
                  />
                  <div class="file-info">
                    <span class="file-name">{file.name}</span>
                    <span class="file-meta">
                      {byteSize(file.size).toString()} • {formatDate(file.createdTime)}
                    </span>
                  </div>
                </label>
              </li>
            {/each}
          </ul>

          {#if storeValue.selectedDriveFiles.length > 0}
            <div class="selection-summary">
              {storeValue.selectedDriveFiles.length} file{storeValue.selectedDriveFiles.length === 1 ? '' : 's'} selected
              ({byteSize(
                takeoutFiles
                  .filter((f) => storeValue.selectedDriveFiles.includes(f.id))
                  .reduce((sum, f) => sum + f.size, 0)
              ).toString()})
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .drive-connect-container {
    background: rgb(var(--immich-bg));
    border: 1px solid rgb(var(--immich-fg) / 0.1);
    border-radius: 0.75rem;
    padding: 1.5rem;
  }

  :global(.dark) .drive-connect-container {
    background: rgb(var(--immich-dark-bg));
    border-color: rgb(var(--immich-dark-fg) / 0.1);
  }

  .header {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
    margin-bottom: 1.5rem;
  }

  .icon {
    flex-shrink: 0;
    width: 3rem;
    height: 3rem;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgb(var(--immich-bg));
    border: 1px solid rgb(var(--immich-fg) / 0.15);
    border-radius: 0.5rem;
  }

  :global(.dark) .icon {
    background: rgb(var(--immich-dark-gray));
    border-color: rgb(var(--immich-dark-fg) / 0.15);
  }

  .drive-logo {
    width: 1.75rem;
    height: 1.75rem;
  }

  .text h3 {
    margin: 0 0 0.25rem 0;
    font-size: 1.125rem;
    font-weight: 600;
    color: rgb(var(--immich-fg));
  }

  :global(.dark) .text h3 {
    color: rgb(var(--immich-dark-fg));
  }

  .text p {
    margin: 0;
    color: rgb(var(--immich-fg) / 0.7);
    font-size: 0.875rem;
  }

  :global(.dark) .text p {
    color: rgb(var(--immich-dark-fg) / 0.7);
  }

  .checking-status {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    padding: 2rem 1rem;
    color: rgb(var(--immich-fg) / 0.7);
  }

  :global(.dark) .checking-status {
    color: rgb(var(--immich-dark-fg) / 0.7);
  }

  .connect-section {
    text-align: center;
    padding: 1rem 0;
  }

  .connect-description {
    margin: 0 0 1.25rem 0;
    color: rgb(var(--immich-fg) / 0.7);
    font-size: 0.875rem;
  }

  :global(.dark) .connect-description {
    color: rgb(var(--immich-dark-fg) / 0.7);
  }

  .error-message {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    margin-bottom: 1.25rem;
    padding: 0.875rem 1rem;
    background: #fef2f2;
    border: 1px solid #dc2626;
    border-radius: 0.5rem;
    color: #dc2626;
    font-size: 0.875rem;
    text-align: left;
  }

  :global(.dark) .error-message {
    background: rgba(220, 38, 38, 0.1);
    border-color: #f87171;
    color: #f87171;
  }

  .error-message svg {
    flex-shrink: 0;
    width: 1.25rem;
    height: 1.25rem;
    margin-top: 0.125rem;
  }

  .error-message span {
    flex: 1;
  }

  .error-message button {
    flex-shrink: 0;
    padding: 0.25rem 0.5rem;
    background: transparent;
    border: 1px solid currentColor;
    border-radius: 0.25rem;
    color: inherit;
    font-size: 0.75rem;
    cursor: pointer;
  }

  .error-message button:hover {
    background: #dc2626;
    color: white;
  }

  :global(.dark) .error-message button:hover {
    background: #f87171;
    color: black;
  }

  .connected-section {
    padding-top: 0.5rem;
  }

  .connected-status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    background: #ecfdf5;
    border-radius: 0.5rem;
    margin-bottom: 1rem;
  }

  :global(.dark) .connected-status {
    background: rgba(16, 185, 129, 0.1);
  }

  .status-badge {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: #059669;
    font-weight: 500;
    font-size: 0.875rem;
  }

  :global(.dark) .status-badge {
    color: #34d399;
  }

  .status-badge svg {
    width: 1.25rem;
    height: 1.25rem;
  }

  .disconnect-btn {
    padding: 0.375rem 0.75rem;
    background: transparent;
    border: 1px solid rgb(var(--immich-fg) / 0.2);
    border-radius: 0.375rem;
    font-size: 0.8125rem;
    color: rgb(var(--immich-fg) / 0.7);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  :global(.dark) .disconnect-btn {
    border-color: rgb(var(--immich-dark-fg) / 0.2);
    color: rgb(var(--immich-dark-fg) / 0.7);
  }

  .disconnect-btn:hover {
    border-color: #dc2626;
    color: #dc2626;
  }

  :global(.dark) .disconnect-btn:hover {
    border-color: #f87171;
    color: #f87171;
  }

  .scanning-drive {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    padding: 2.5rem 1rem;
    background: rgb(var(--immich-primary) / 0.05);
    border-radius: 0.5rem;
    margin-top: 1rem;
  }

  :global(.dark) .scanning-drive {
    background: rgb(var(--immich-dark-primary) / 0.05);
  }

  .scanning-animation {
    position: relative;
  }

  .scanning-text {
    text-align: center;
  }

  .scanning-text h4 {
    margin: 0 0 0.25rem 0;
    font-size: 1rem;
    font-weight: 600;
    color: rgb(var(--immich-fg));
  }

  :global(.dark) .scanning-text h4 {
    color: rgb(var(--immich-dark-fg));
  }

  .scanning-text p {
    margin: 0;
    font-size: 0.875rem;
    color: rgb(var(--immich-fg) / 0.7);
  }

  :global(.dark) .scanning-text p {
    color: rgb(var(--immich-dark-fg) / 0.7);
  }

  .spinner.large {
    width: 2.5rem;
    height: 2.5rem;
    border-width: 3px;
  }

  .no-files {
    text-align: center;
    padding: 2rem 1rem;
    color: rgb(var(--immich-fg) / 0.7);
  }

  :global(.dark) .no-files {
    color: rgb(var(--immich-dark-fg) / 0.7);
  }

  .no-files p {
    margin: 0 0 0.5rem 0;
  }

  .no-files .hint {
    font-size: 0.8125rem;
    margin-bottom: 1rem;
  }

  .no-files h4 {
    margin: 0.75rem 0 0.5rem 0;
    font-size: 1rem;
    font-weight: 600;
    color: rgb(var(--immich-fg));
  }

  :global(.dark) .no-files h4 {
    color: rgb(var(--immich-dark-fg));
  }

  .waiting-icon {
    display: flex;
    justify-content: center;
    margin-bottom: 0.5rem;
  }

  .waiting-icon svg {
    width: 3rem;
    height: 3rem;
    color: rgb(var(--immich-primary));
    animation: pulse 2s ease-in-out infinite;
  }

  :global(.dark) .waiting-icon svg {
    color: rgb(var(--immich-dark-primary));
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  .auto-refresh-status {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 1rem 0;
    padding: 0.75rem 1rem;
    background: rgb(var(--immich-primary) / 0.1);
    border: 1px solid rgb(var(--immich-primary) / 0.2);
    border-radius: 0.5rem;
    font-size: 0.875rem;
    color: rgb(var(--immich-fg));
  }

  :global(.dark) .auto-refresh-status {
    background: rgb(var(--immich-dark-primary) / 0.1);
    border-color: rgb(var(--immich-dark-primary) / 0.2);
  }

  .refresh-indicator {
    width: 0.5rem;
    height: 0.5rem;
    background: rgb(var(--immich-primary));
    border-radius: 50%;
    animation: blink 1s ease-in-out infinite;
  }

  :global(.dark) .refresh-indicator {
    background: rgb(var(--immich-dark-primary));
  }

  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  .last-check {
    margin-left: 0.5rem;
    padding-left: 0.5rem;
    border-left: 1px solid rgb(var(--immich-fg) / 0.3);
    opacity: 0.7;
  }

  .spinner {
    width: 1.25rem;
    height: 1.25rem;
    border: 2px solid rgb(var(--immich-fg) / 0.2);
    border-top-color: rgb(var(--immich-primary));
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  :global(.dark) .spinner {
    border-color: rgb(var(--immich-dark-fg) / 0.2);
    border-top-color: rgb(var(--immich-dark-primary));
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .file-list {
    margin-top: 1rem;
  }

  .file-list-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.75rem;
  }

  .file-list-header h4 {
    margin: 0;
    font-size: 0.875rem;
    font-weight: 600;
    color: rgb(var(--immich-fg));
  }

  :global(.dark) .file-list-header h4 {
    color: rgb(var(--immich-dark-fg));
  }

  .selection-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8125rem;
  }

  .link-btn {
    background: none;
    border: none;
    color: rgb(var(--immich-primary));
    cursor: pointer;
    padding: 0;
    font-size: inherit;
  }

  :global(.dark) .link-btn {
    color: rgb(var(--immich-dark-primary));
  }

  .link-btn:hover {
    text-decoration: underline;
  }

  .separator {
    color: rgb(var(--immich-fg) / 0.3);
  }

  :global(.dark) .separator {
    color: rgb(var(--immich-dark-fg) / 0.3);
  }

  .file-list ul {
    margin: 0;
    padding: 0;
    list-style: none;
    max-height: 300px;
    overflow-y: auto;
    border: 1px solid rgb(var(--immich-fg) / 0.1);
    border-radius: 0.5rem;
  }

  :global(.dark) .file-list ul {
    border-color: rgb(var(--immich-dark-fg) / 0.1);
  }

  .file-list li {
    border-bottom: 1px solid rgb(var(--immich-fg) / 0.1);
  }

  :global(.dark) .file-list li {
    border-color: rgb(var(--immich-dark-fg) / 0.1);
  }

  .file-list li:last-child {
    border-bottom: none;
  }

  .file-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .file-row:hover {
    background: rgb(var(--immich-fg) / 0.05);
  }

  :global(.dark) .file-row:hover {
    background: rgb(var(--immich-dark-fg) / 0.05);
  }

  .file-info {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
  }

  .file-name {
    font-size: 0.875rem;
    color: rgb(var(--immich-fg));
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  :global(.dark) .file-name {
    color: rgb(var(--immich-dark-fg));
  }

  .file-meta {
    font-size: 0.75rem;
    color: rgb(var(--immich-fg) / 0.6);
  }

  :global(.dark) .file-meta {
    color: rgb(var(--immich-dark-fg) / 0.6);
  }

  .selection-summary {
    margin-top: 0.75rem;
    padding: 0.5rem 0.75rem;
    background: rgb(var(--immich-primary) / 0.1);
    border-radius: 0.375rem;
    font-size: 0.8125rem;
    color: rgb(var(--immich-fg));
    text-align: center;
  }

  :global(.dark) .selection-summary {
    background: rgb(var(--immich-dark-primary) / 0.1);
    color: rgb(var(--immich-dark-fg));
  }
</style>
