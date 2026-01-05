<script lang="ts">
  import { googlePhotosImportStore, type ImportPhase, type ActivityEventType } from '$lib/stores/google-photos-import.store';
  import { Button } from '@immich/ui';

  interface Props {
    onComplete?: () => void;
    onCancel?: () => void;
  }

  let { onComplete, onCancel }: Props = $props();

  // Track store state with proper Svelte 5 reactivity
  let store = $state<typeof $googlePhotosImportStore>($googlePhotosImportStore);
  let timelineContainer: HTMLElement | null = $state(null);

  $effect(() => {
    const unsubscribe = googlePhotosImportStore.subscribe((v) => {
      store = v;
    });
    return unsubscribe;
  });

  // Auto-scroll timeline to bottom when new events are added
  $effect(() => {
    if (store.progress?.events && timelineContainer) {
      timelineContainer.scrollTop = timelineContainer.scrollHeight;
    }
  });

  const progress = $derived(store.progress);

  // Stepper configuration
  const steps: { phase: ImportPhase; label: string }[] = [
    { phase: 'downloading', label: 'Downloading' },
    { phase: 'processing', label: 'Processing' },
    { phase: 'complete', label: 'Complete' },
  ];

  function getStepStatus(stepPhase: ImportPhase, currentPhase: ImportPhase | undefined): 'pending' | 'active' | 'complete' | 'error' {
    if (!currentPhase) return 'pending';
    if (currentPhase === 'failed') return stepPhase === 'downloading' ? 'error' : 'pending';

    const stepIndex = steps.findIndex(s => s.phase === stepPhase);
    const currentIndex = steps.findIndex(s => s.phase === currentPhase);

    if (stepIndex < currentIndex) return 'complete';
    if (stepIndex === currentIndex) return currentPhase === 'complete' ? 'complete' : 'active';
    return 'pending';
  }

  function getEventIcon(type: ActivityEventType): string {
    switch (type) {
      case 'success': return 'M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z';
      case 'error': return 'M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z';
      case 'download': return 'M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3';
      case 'upload': return 'M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5';
      case 'album': return 'M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z';
      default: return 'M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z';
    }
  }

  function formatTime(timestamp: string): string {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function formatBytes(bytes: number | undefined): string {
    if (!bytes) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function handleComplete() {
    googlePhotosImportStore.reset();
    onComplete?.();
  }

  function handleCancel() {
    onCancel?.();
  }
</script>

<div class="progress-container">
  {#if progress}
    <!-- Stepper -->
    <div class="stepper">
      {#each steps as step, i}
        {@const status = getStepStatus(step.phase, progress.phase)}
        <div class="step" class:active={status === 'active'} class:complete={status === 'complete'} class:error={status === 'error'}>
          <div class="step-indicator">
            {#if status === 'complete'}
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clip-rule="evenodd" />
              </svg>
            {:else if status === 'error'}
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
              </svg>
            {:else if status === 'active'}
              <div class="spinner"></div>
            {:else}
              <span>{i + 1}</span>
            {/if}
          </div>
          <span class="step-label">{step.label}</span>
        </div>
        {#if i < steps.length - 1}
          <div class="step-connector" class:complete={status === 'complete'}></div>
        {/if}
      {/each}
    </div>

    <!-- Stats -->
    <div class="stats-row">
      <div class="stat">
        <span class="stat-value">{progress.photosImported}</span>
        <span class="stat-label">Photos</span>
      </div>
      <div class="stat">
        <span class="stat-value">{progress.albumsFound}</span>
        <span class="stat-label">Albums</span>
      </div>
      {#if progress.bytesDownloaded !== undefined}
        <div class="stat">
          <span class="stat-value">{formatBytes(progress.bytesDownloaded)}</span>
          <span class="stat-label">Downloaded</span>
        </div>
      {/if}
    </div>

    <!-- Activity Timeline -->
    <div class="timeline-section">
      <h3>Activity</h3>
      <div class="timeline" bind:this={timelineContainer}>
        {#each progress.events as event}
          <div class="timeline-event" class:success={event.type === 'success'} class:error={event.type === 'error'}>
            <div class="event-icon" class:success={event.type === 'success'} class:error={event.type === 'error'}>
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" d={getEventIcon(event.type)} />
              </svg>
            </div>
            <div class="event-content">
              <span class="event-time">{formatTime(event.timestamp)}</span>
              <span class="event-message">{event.message}</span>
            </div>
          </div>
        {/each}
      </div>
    </div>

    <!-- Errors -->
    {#if progress.errors.length > 0}
      <div class="errors-section">
        <h4>Errors ({progress.errors.length})</h4>
        <ul>
          {#each progress.errors.slice(0, 5) as error}
            <li>{error}</li>
          {/each}
          {#if progress.errors.length > 5}
            <li class="more">...and {progress.errors.length - 5} more</li>
          {/if}
        </ul>
      </div>
    {/if}

    <!-- Actions -->
    <div class="actions">
      {#if progress.phase === 'complete'}
        <Button onclick={handleComplete} color="primary">Done</Button>
      {:else if progress.phase === 'failed'}
        <Button onclick={handleComplete} color="secondary">Close</Button>
      {:else}
        <Button onclick={handleCancel} color="secondary">Cancel</Button>
      {/if}
    </div>
  {:else}
    <div class="no-progress">
      <p>No import in progress</p>
    </div>
  {/if}
</div>

<style>
  .progress-container {
    background: var(--immich-bg);
    border: 1px solid var(--immich-border);
    border-radius: 0.75rem;
    padding: 1.5rem;
  }

  /* Stepper */
  .stepper {
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 1.5rem;
    padding: 0 1rem;
  }

  .step {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
  }

  .step-indicator {
    width: 2.5rem;
    height: 2.5rem;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--immich-bg-hover);
    color: var(--immich-fg-muted);
    font-weight: 600;
    font-size: 0.875rem;
    border: 2px solid var(--immich-border);
    transition: all 0.2s;
  }

  .step-indicator svg {
    width: 1.25rem;
    height: 1.25rem;
  }

  .step.active .step-indicator {
    background: var(--immich-primary);
    color: white;
    border-color: var(--immich-primary);
  }

  .step.complete .step-indicator {
    background: var(--immich-success, #059669);
    color: white;
    border-color: var(--immich-success, #059669);
  }

  .step.error .step-indicator {
    background: var(--immich-danger, #dc2626);
    color: white;
    border-color: var(--immich-danger, #dc2626);
  }

  .step-label {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--immich-fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .step.active .step-label,
  .step.complete .step-label {
    color: var(--immich-fg);
  }

  .step-connector {
    flex: 1;
    height: 2px;
    background: var(--immich-border);
    margin: 0 0.5rem;
    margin-bottom: 1.5rem;
    max-width: 4rem;
    transition: background 0.2s;
  }

  .step-connector.complete {
    background: var(--immich-success, #059669);
  }

  .spinner {
    width: 1rem;
    height: 1rem;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* Stats */
  .stats-row {
    display: flex;
    justify-content: center;
    gap: 2rem;
    margin-bottom: 1.5rem;
    padding: 1rem;
    background: var(--immich-bg-hover);
    border-radius: 0.5rem;
  }

  .stat {
    text-align: center;
  }

  .stat-value {
    display: block;
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--immich-fg);
  }

  .stat-label {
    font-size: 0.75rem;
    color: var(--immich-fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  /* Timeline */
  .timeline-section {
    margin-bottom: 1.5rem;
  }

  .timeline-section h3 {
    margin: 0 0 0.75rem 0;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--immich-fg);
  }

  .timeline {
    max-height: 200px;
    overflow-y: auto;
    border: 1px solid var(--immich-border);
    border-radius: 0.5rem;
    padding: 0.75rem;
    background: var(--immich-bg);
  }

  .timeline-event {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--immich-border);
  }

  .timeline-event:last-child {
    border-bottom: none;
  }

  .event-icon {
    flex-shrink: 0;
    width: 1.5rem;
    height: 1.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--immich-fg-muted);
  }

  .event-icon svg {
    width: 1rem;
    height: 1rem;
  }

  .event-icon.success {
    color: var(--immich-success, #059669);
  }

  .event-icon.error {
    color: var(--immich-danger, #dc2626);
  }

  .event-content {
    flex: 1;
    min-width: 0;
  }

  .event-time {
    font-size: 0.625rem;
    color: var(--immich-fg-muted);
    font-family: monospace;
    margin-right: 0.5rem;
  }

  .event-message {
    font-size: 0.8125rem;
    color: var(--immich-fg);
    word-break: break-word;
  }

  .timeline-event.error .event-message {
    color: var(--immich-danger, #dc2626);
  }

  /* Errors */
  .errors-section {
    margin-bottom: 1.5rem;
    padding: 1rem;
    background: var(--immich-danger-bg, #fef2f2);
    border-radius: 0.5rem;
  }

  .errors-section h4 {
    margin: 0 0 0.5rem 0;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--immich-danger, #dc2626);
  }

  .errors-section ul {
    margin: 0;
    padding-left: 1.25rem;
    font-size: 0.8125rem;
    color: var(--immich-danger, #dc2626);
  }

  .errors-section li {
    margin-bottom: 0.25rem;
  }

  .errors-section .more {
    font-style: italic;
    color: var(--immich-fg-muted);
  }

  /* Actions */
  .actions {
    display: flex;
    justify-content: center;
    gap: 1rem;
  }

  .no-progress {
    text-align: center;
    padding: 2rem;
    color: var(--immich-fg-muted);
  }
</style>
