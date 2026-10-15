// Settings › Import / export — "Exporter l'espace" card.
import { useEffect, useRef, useState } from 'react';
import { Braces, CircleCheck, Download, FileArchive, TriangleAlert } from 'lucide-react';
import { useWorkspaceCtx } from '../shell/WorkspaceContext';
import { Spinner } from '../components/common';
import type { ExportProgress, ExportResult } from './exporter';
import { MessageList, ProgressBar, plural } from './ui';

type State =
  | { status: 'idle' }
  | { status: 'running'; format: 'zip' | 'json'; progress: ExportProgress | null }
  | { status: 'done'; result: ExportResult }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

const PHASES: Record<ExportProgress['phase'], string> = {
  scan: 'Lecture des bases de données',
  pages: 'Conversion des pages',
  files: 'Téléchargement des fichiers',
  finish: 'Finalisation de l’archive',
};

export function ExportCard() {
  const { workspaceId, workspace } = useWorkspaceCtx();
  const [state, setState] = useState<State>({ status: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    if (state.status !== 'running') return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [state.status]);

  const start = async (format: 'zip' | 'json') => {
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ status: 'running', format, progress: null });
    try {
      const { exportWorkspace, saveBlob } = await import('./exporter');
      const result = await exportWorkspace({
        workspaceId,
        workspaceName: workspace.name,
        workspaceIcon: workspace.icon,
        format,
        signal: controller.signal,
        onProgress: (progress) => setState((s) => (s.status === 'running' ? { ...s, progress } : s)),
      });
      if (controller.signal.aborted) return setState({ status: 'cancelled' });
      saveBlob(result.blob, result.filename);
      setState({ status: 'done', result });
    } catch (e) {
      if (controller.signal.aborted) setState({ status: 'cancelled' });
      else setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const running = state.status === 'running';
  return (
    <section className="io-card" aria-labelledby="io-export-title">
      <header className="io-card__header">
        <span className="io-card__icon" aria-hidden>
          <Download size={18} />
        </span>
        <div>
          <h2 id="io-export-title" className="io-card__title">
            Exporter l’espace
          </h2>
          <p className="io-card__desc">
            Téléchargez une archive .zip de tout ce que vous voyez dans « {workspace.name} » : une page Markdown par page, un fichier
            CSV par base de données (avec un dossier pour ses lignes), et les fichiers joints. Vos pages privées sont incluses.
          </p>
        </div>
      </header>

      <div className="io-card__actions">
        <button type="button" className="btn btn--primary" disabled={running} onClick={() => void start('zip')}>
          {running && state.format === 'zip' ? <Spinner size={14} /> : <FileArchive size={15} />} Exporter en Markdown + CSV (.zip)
        </button>
        <button type="button" className="btn btn--secondary" disabled={running} onClick={() => void start('json')}>
          {running && state.format === 'json' ? <Spinner size={14} /> : <Braces size={15} />} Sauvegarde complète (JSON)
        </button>
      </div>

      {running && (
        <div className="io-run">
          <ProgressBar
            done={state.progress?.done ?? 0}
            total={state.progress?.total ?? 0}
            phase={state.progress ? PHASES[state.progress.phase] : 'Préparation…'}
            label={state.progress?.label ?? ''}
          />
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => abortRef.current?.abort()}>
            Annuler
          </button>
        </div>
      )}

      {state.status === 'done' && (
        <div className="io-result" role="status">
          <p className="io-result__title">
            <CircleCheck size={16} className="io-ok" /> Export terminé : {plural(state.result.counts.pages, 'page')},{' '}
            {plural(state.result.counts.databases, 'base')}, {plural(state.result.counts.rows, 'ligne')}, {plural(state.result.counts.files, 'fichier')}.
          </p>
          <p className="io-muted">
            Le téléchargement de « {state.result.filename} » a démarré.{' '}
            <button type="button" className="link-button" onClick={() => void import('./exporter').then((m) => m.saveBlob(state.result.blob, state.result.filename))}>
              Télécharger à nouveau
            </button>
          </p>
          <MessageList title="Erreurs" tone="error" items={state.result.errors} />
          <MessageList title="Avertissements" tone="warning" items={state.result.warnings} />
        </div>
      )}
      {state.status === 'cancelled' && <p className="io-muted">Export annulé.</p>}
      {state.status === 'error' && (
        <p className="io-error" role="alert">
          <TriangleAlert size={15} /> Export impossible : {state.message}
        </p>
      )}
    </section>
  );
}
