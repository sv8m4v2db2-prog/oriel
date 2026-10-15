// Settings › Import / export — "Importer" card: drop zone, analysis preview, destination,
// progress and final report.
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { CircleCheck, Database, FileText, FolderOpen, Lock, Paperclip, TriangleAlert, Upload, Users, X } from 'lucide-react';
import type { TreeNode } from '@oriel/shared';
import { useWorkspaceCtx } from '../shell/WorkspaceContext';
import { Spinner } from '../components/common';
import { api } from '../lib/api';
import { queryClient } from '../lib/queryClient';
import { qk } from '../lib/queryKeys';
import { childrenOf, rootNodes, useTree } from '../lib/tree';
import { confirmDialog, openPagePicker, toast } from '../lib/ui';
import { appNavigate, pagePath, pageTitle } from '../lib/util';
import { findDuplicates, type ImportDestination, type ImportProgress, type ImportReport } from './importTypes';
import { planImport, type ImportPlan, type PlanDatabase, type PlanNode } from './plan';
import { activePlan } from './importers/builder';
import { combinePlans, detectImporters } from './importers/detect';
import { HINTABLE_TYPES, inferColumn, type ColumnHint } from './csv';
import { Vfs, buildVfs, filesFromDataTransfer, filesFromInput, type InputFile } from './vfs';
import { MessageList, ProgressBar, Stat, plural } from './ui';

type State =
  | { status: 'idle' }
  | { status: 'analyzing'; label: string }
  | { status: 'ready'; vfs: Vfs; plan: ImportPlan; source: string }
  | { status: 'running'; plan: ImportPlan; progress: ImportProgress | null }
  | { status: 'done'; report: ImportReport }
  | { status: 'error'; message: string };

const FORMAT_LABELS: Record<ImportPlan['format'], string> = {
  notion: 'Export Markdown & CSV de votre ancien outil de notes',
  oriel: 'Archive d’export Oriel (types de propriétés, icônes et vues conservés)',
  markdown: 'Fichiers Markdown / CSV',
  docx: 'Document Word (.docx)',
  'gdocs-html': 'Export HTML de Google Docs',
  xlsx: 'Classeur Excel (.xlsx)',
  confluence: 'Export HTML d’un espace Confluence',
  evernote: 'Export Evernote (.enex)',
  trello: 'Export JSON d’un tableau Trello',
  asana: 'Export CSV d’un projet Asana',
};

const PHASES: Record<ImportProgress['phase'], string> = {
  structure: 'Création des pages, bases et lignes',
  content: 'Contenu des pages',
  files: 'Pièces jointes',
};

function describe(inputs: InputFile[]): string {
  if (inputs.length === 1) return inputs[0]!.path;
  const top = new Set(inputs.map((i) => i.path.split('/')[0]));
  return top.size === 1 ? `${[...top][0]} (${plural(inputs.length, 'fichier')})` : plural(inputs.length, 'fichier');
}

function countDescendants(node: PlanNode): string {
  if (node.kind === 'database') return plural(node.rows.length, 'ligne');
  let n = 0;
  const walk = (list: PlanNode[]) =>
    list.forEach((c) => {
      n++;
      if (c.kind === 'page') walk(c.children);
    });
  walk(node.children);
  return n ? plural(n, 'sous-élément') : '';
}

export function ImportCard() {
  const { workspaceId, workspace } = useWorkspaceCtx();
  const tree = useTree(workspaceId);
  const [state, setState] = useState<State>({ status: 'idle' });
  const [destination, setDestination] = useState<ImportDestination>({ type: 'root', visibility: 'workspace' });
  const [skipExisting, setSkipExisting] = useState(true);
  const [dragging, setDragging] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    if (state.status !== 'running') return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [state.status]);
  useEffect(() => {
    folderInput.current?.setAttribute('webkitdirectory', '');
    folderInput.current?.setAttribute('directory', '');
  }, []);

  const existing: TreeNode[] = useMemo(() => {
    if (destination.type === 'root') return rootNodes(tree.index, workspaceId, destination.visibility);
    return childrenOf(tree.index, destination.pageId);
  }, [tree.index, workspaceId, destination]);
  const duplicates = useMemo(() => (state.status === 'ready' ? findDuplicates(state.plan, existing) : []), [state, existing]);

  const analyze = async (inputs: InputFile[]) => {
    if (inputs.length === 0) return;
    setState({ status: 'analyzing', label: describe(inputs) });
    try {
      const vfs = await buildVfs(inputs);
      if (vfs.size === 0) throw new Error(vfs.warnings[0] ?? 'Aucun fichier exploitable.');
      const detected = await detectImporters(vfs);
      let legacy: ImportPlan | null = null;
      const rest = detected.handled.size === 0 ? vfs : new Vfs();
      if (rest !== vfs) for (const f of vfs.list()) if (!detected.handled.has(f.path) && !f.path.includes('.medias/') && !f.path.includes('.pieces-jointes/') && !f.path.includes('.images/')) rest.add(f);
      if (rest.list().some((f) => /\.(md|markdown|csv)$/i.test(f.path)) || !detected.plan) legacy = await planImport(rest);
      if (legacy && legacy.roots.length === 0 && !detected.plan) throw new Error('Aucun fichier reconnu : Markdown, CSV, Word, Excel, Confluence, Evernote, Trello ou Asana.');
      const plan = combinePlans(detected.plan, legacy);
      setState({ status: 'ready', vfs, plan, source: describe(inputs) });
    } catch (e) {
      setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (state.status === 'running' || state.status === 'analyzing') return;
    void filesFromDataTransfer(e.dataTransfer).then(analyze);
  };

  const pickDestination = () =>
    openPagePicker({
      title: 'Importer dans…',
      allowRoots: true,
      onPick: (target) => {
        if (target.kind === 'root') setDestination({ type: 'root', visibility: target.visibility });
        else setDestination({ type: 'page', pageId: target.id, title: pageTitle(tree.index.byId.get(target.id)?.title) });
      },
    });

  const start = async () => {
    if (state.status !== 'ready') return;
    const { vfs } = state;
    const plan = activePlan(state.plan);
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ status: 'running', plan, progress: null });
    try {
      const { runImport } = await import('./importer');
      const report = await runImport(plan, vfs, {
        workspaceId,
        destination,
        skipExisting,
        existing,
        signal: controller.signal,
        onProgress: (progress) => setState((s) => (s.status === 'running' ? { ...s, progress } : s)),
      });
      setState({ status: 'done', report });
    } catch (e) {
      setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      abortRef.current = null;
      void queryClient.invalidateQueries({ queryKey: qk.tree(workspaceId) });
    }
  };

  const undo = async (report: ImportReport) => {
    const ok = await confirmDialog({
      title: 'Mettre l’import à la corbeille ?',
      message: `${plural(report.roots.length, 'élément')} de premier niveau (et tout leur contenu) seront déplacés dans la corbeille.`,
      confirmLabel: 'Mettre à la corbeille',
      danger: true,
    });
    if (!ok) return;
    let failed = 0;
    for (const r of report.roots) {
      try {
        await api.pages.trash(r.id);
      } catch {
        failed++;
      }
    }
    void queryClient.invalidateQueries({ queryKey: qk.tree(workspaceId) });
    void queryClient.invalidateQueries({ queryKey: qk.trash(workspaceId) });
    if (failed) toast.error(`${plural(failed, 'élément')} n’a pas pu être supprimé.`);
    else toast.success('Import placé dans la corbeille');
    setState({ status: 'idle' });
  };

  const reset = () => setState({ status: 'idle' });
  const busy = state.status === 'running' || state.status === 'analyzing';

  return (
    <section className="io-card" aria-labelledby="io-import-title">
      <header className="io-card__header">
        <span className="io-card__icon" aria-hidden>
          <Upload size={18} />
        </span>
        <div>
          <h2 id="io-import-title" className="io-card__title">
            Importer
          </h2>
          <p className="io-card__desc">
            Importez l’export de votre ancien outil de notes (archive .zip « Markdown & CSV »), une archive exportée depuis Oriel,
            des fichiers .md et .csv, un document Word (.docx) ou Google Docs (.docx ou .html), un classeur Excel (.xlsx), un export
            Confluence (.zip HTML), Evernote (.enex), Trello (JSON) ou Asana (CSV). Les sous-pages, bases de données, liens entre
            pages, images et fichiers joints sont conservés ; rien n’est téléchargé depuis Internet.
          </p>
        </div>
      </header>

      {(state.status === 'idle' || state.status === 'error' || state.status === 'analyzing') && (
        <div
          className={`io-drop${dragging ? ' is-dragging' : ''}${busy ? ' is-busy' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            if (!busy) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          {state.status === 'analyzing' ? (
            <>
              <Spinner size={22} />
              <p className="io-drop__title">Analyse de « {state.label} »…</p>
            </>
          ) : (
            <>
              <FolderOpen size={26} className="io-drop__icon" />
              <p className="io-drop__title">Déposez ici un fichier .zip, .docx, .xlsx, .enex, .json, .html, des fichiers Markdown / CSV ou un dossier</p>
              <div className="io-drop__buttons">
                <button type="button" className="btn btn--secondary btn--sm" onClick={() => filesInput.current?.click()}>
                  Choisir des fichiers
                </button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => folderInput.current?.click()}>
                  Choisir un dossier
                </button>
              </div>
              <p className="io-drop__hint">Les archives contenant d’autres archives (export en plusieurs parties) sont décompressées automatiquement.</p>
            </>
          )}
          <input
            ref={filesInput}
            type="file"
            multiple
            hidden
            accept=".zip,.md,.markdown,.csv,.docx,.xlsx,.html,.htm,.enex,.json,application/zip,text/markdown,text/csv"
            onChange={(e) => {
              void analyze(filesFromInput(e.target.files));
              e.target.value = '';
            }}
          />
          <input
            ref={folderInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void analyze(filesFromInput(e.target.files));
              e.target.value = '';
            }}
          />
        </div>
      )}

      {state.status === 'error' && (
        <p className="io-error" role="alert">
          <TriangleAlert size={15} /> {state.message}
        </p>
      )}

      {state.status === 'ready' && (
        <div className="io-preview">
          <div className="io-preview__source">
            <span className="io-badge">{FORMAT_LABELS[state.plan.format]}</span>
            <span className="io-muted">{state.source}</span>
            <button type="button" className="btn btn--ghost btn--sm io-preview__close" onClick={reset} aria-label="Choisir d’autres fichiers">
              <X size={14} />
            </button>
          </div>
          <div className="io-stats">
            <Stat value={state.plan.counts.pages} label={state.plan.counts.pages > 1 ? 'pages' : 'page'} icon={<FileText size={15} />} />
            <Stat value={state.plan.counts.databases} label={state.plan.counts.databases > 1 ? 'bases de données' : 'base de données'} icon={<Database size={15} />} />
            <Stat value={state.plan.counts.rows} label={state.plan.counts.rows > 1 ? 'lignes' : 'ligne'} />
            <Stat value={state.plan.counts.attachments} label={state.plan.counts.attachments > 1 ? 'fichiers joints' : 'fichier joint'} icon={<Paperclip size={15} />} />
          </div>
          <ul className="io-roots">
            {state.plan.roots.slice(0, 12).map((n) => (
              <li key={n.uid}>
                {n.kind === 'database' ? <Database size={14} /> : <FileText size={14} />}
                <span className="io-roots__title">
                  {n.icon ? `${n.icon} ` : ''}
                  {n.title}
                </span>
                <span className="io-muted">{countDescendants(n)}</span>
              </li>
            ))}
            {state.plan.roots.length > 12 && <li className="io-muted">… et {plural(state.plan.roots.length - 12, 'autre élément')}</li>}
          </ul>
          <MessageList title="Points d’attention" tone="warning" items={state.plan.warnings} />
          {state.plan.format === 'xlsx' && (
            <SheetPreview
              databases={state.plan.roots.filter((n): n is PlanDatabase => n.kind === 'database')}
              onChange={() => setState((s) => (s.status === 'ready' ? { ...s, plan: { ...s.plan } } : s))}
            />
          )}

          <div className="io-destination">
            <span className="field-label">Destination</span>
            <div className="segmented segmented--inline" role="radiogroup" aria-label="Destination de l’import">
              <button
                type="button"
                role="radio"
                aria-checked={destination.type === 'root' && destination.visibility === 'workspace'}
                className={destination.type === 'root' && destination.visibility === 'workspace' ? 'is-active' : ''}
                onClick={() => setDestination({ type: 'root', visibility: 'workspace' })}
              >
                <Users size={14} /> {workspace.name}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={destination.type === 'root' && destination.visibility === 'private'}
                className={destination.type === 'root' && destination.visibility === 'private' ? 'is-active' : ''}
                onClick={() => setDestination({ type: 'root', visibility: 'private' })}
              >
                <Lock size={14} /> Privé
              </button>
              <button type="button" role="radio" aria-checked={destination.type === 'page'} className={destination.type === 'page' ? 'is-active' : ''} onClick={pickDestination}>
                <FileText size={14} /> {destination.type === 'page' ? `Dans « ${destination.title} »` : 'Dans une page…'}
              </button>
            </div>
            {state.plan.format === 'oriel' && destination.type === 'root' && (
              <p className="field-hint">Les éléments privés de l’archive retrouvent la section « Privé ».</p>
            )}
          </div>

          {duplicates.length > 0 && (
            <label className="io-check">
              <input type="checkbox" checked={skipExisting} onChange={(e) => setSkipExisting(e.target.checked)} />
              <span>
                Ignorer {plural(duplicates.length, 'élément')} déjà présent{duplicates.length > 1 ? 's' : ''} à la destination (
                {duplicates
                  .slice(0, 3)
                  .map((d) => `« ${d.title} »`)
                  .join(', ')}
                {duplicates.length > 3 ? '…' : ''})
              </span>
            </label>
          )}

          <div className="io-card__actions">
            <button type="button" className="btn btn--primary" onClick={() => void start()}>
              <Upload size={15} /> Importer
            </button>
            <button type="button" className="btn btn--ghost" onClick={reset}>
              Annuler
            </button>
          </div>
        </div>
      )}

      {state.status === 'running' && (
        <div className="io-run">
          <ProgressBar
            done={state.progress?.done ?? 0}
            total={state.progress?.total ?? 0}
            phase={state.progress ? PHASES[state.progress.phase] : 'Préparation…'}
            label={state.progress?.label}
          />
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => abortRef.current?.abort()}>
            Arrêter
          </button>
        </div>
      )}

      {state.status === 'done' && (
        <div className="io-result" role="status">
          <p className="io-result__title">
            {state.report.cancelled ? <TriangleAlert size={16} className="io-warn" /> : <CircleCheck size={16} className="io-ok" />}
            {state.report.cancelled ? 'Import interrompu' : 'Import terminé'} en {Math.max(1, Math.round(state.report.durationMs / 1000))} s
          </p>
          <div className="io-stats">
            <Stat value={state.report.created.pages} label="pages créées" />
            <Stat value={state.report.created.databases} label="bases créées" />
            <Stat value={state.report.created.rows} label="lignes" />
            <Stat value={state.report.created.files} label="fichiers envoyés" />
          </div>
          {state.report.roots.length > 0 && (
            <ul className="io-roots">
              {state.report.roots.slice(0, 12).map((r) => (
                <li key={r.id}>
                  {r.kind === 'database' ? <Database size={14} /> : <FileText size={14} />}
                  <a
                    href={pagePath(workspaceId, r.id)}
                    className="io-roots__title"
                    onClick={(e) => {
                      e.preventDefault();
                      appNavigate(pagePath(workspaceId, r.id));
                    }}
                  >
                    {r.title || 'Sans titre'}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {state.report.skipped.length > 0 && <MessageList title="Ignorés (déjà présents)" tone="info" items={state.report.skipped} />}
          <MessageList title="Erreurs" tone="error" items={state.report.errors} open />
          <MessageList title="Avertissements" tone="warning" items={state.report.warnings} />
          <div className="io-card__actions">
            <button type="button" className="btn btn--secondary" onClick={reset}>
              Nouvel import
            </button>
            {state.report.roots.length > 0 && (
              <button type="button" className="btn btn--danger-text" onClick={() => void undo(state.report)}>
                Mettre l’import à la corbeille
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

const TYPE_LABELS: Record<string, string> = {
  text: 'Texte',
  number: 'Nombre',
  date: 'Date',
  checkbox: 'Case à cocher',
  select: 'Sélection',
  multi_select: 'Multi-sélection',
  status: 'Statut',
  url: 'URL',
  email: 'E-mail',
  phone: 'Téléphone',
  person: 'Personne',
};

/** Excel preview: sheets to import, column names and types (editable before the import). */
function SheetPreview({ databases, onChange }: { databases: PlanDatabase[]; onChange: () => void }) {
  const setHint = (db: PlanDatabase, i: number, patch: ColumnHint) => {
    db.columnHints = { ...(db.columnHints ?? {}), [i]: { ...(db.columnHints?.[i] ?? {}), ...patch } };
    onChange();
  };
  return (
    <div className="io-sheets">
      {databases.map((db) => (
        <details key={db.uid} className="io-sheet" open={databases.length === 1}>
          <summary>
            <label className="io-check">
              <input
                type="checkbox"
                checked={!db.excluded}
                onChange={(e) => {
                  db.excluded = !e.target.checked;
                  onChange();
                }}
              />
              <span>
                {db.title} <span className="io-muted">({plural(db.rows.length, 'ligne')})</span>
              </span>
            </label>
          </summary>
          {db.notes?.map((n) => (
            <p key={n} className="io-muted">
              {n}
            </p>
          ))}
          <table className="io-sheet__table">
            <thead>
              <tr>
                {db.headers.map((h, i) => {
                  const hint = db.columnHints?.[i];
                  const inferred =
                    i === db.titleIndex ? 'title' : inferColumn(i, h, db.rows.slice(0, 500).map((r) => r.cells[i] ?? '')).type;
                  return (
                    <th key={i}>
                      <input
                        aria-label={`Nom de la colonne ${i + 1}`}
                        value={hint?.name ?? h}
                        disabled={i === db.titleIndex}
                        onChange={(e) => {
                          if (i === db.titleIndex) return;
                          setHint(db, i, { name: e.target.value });
                        }}
                      />
                      {i === db.titleIndex ? (
                        <span className="io-muted">Titre</span>
                      ) : (
                        <select
                          aria-label={`Type de la colonne ${h}`}
                          value={hint?.skip ? 'skip' : (hint?.type ?? inferred)}
                          onChange={(e) => {
                            if (e.target.value === 'skip') setHint(db, i, { skip: true });
                            else setHint(db, i, { skip: false, type: e.target.value as ColumnHint['type'] });
                          }}
                        >
                          {HINTABLE_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {TYPE_LABELS[t]}
                            </option>
                          ))}
                          <option value="skip">Ne pas importer</option>
                        </select>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {db.rows.slice(0, 3).map((r) => (
                <tr key={r.uid}>
                  {db.headers.map((_, i) => (
                    <td key={i}>{(r.cells[i] ?? '').slice(0, 40)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ))}
    </div>
  );
}
