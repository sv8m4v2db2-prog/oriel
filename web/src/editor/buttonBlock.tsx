// Button block (« Bouton »): a label, an icon and a sequence of actions run on click, with the rights
// of the user who clicks, through the REST API only (rows) or the shared document (inserted blocks).
// Disabled in read-only mode and for anonymous visitors. Actions are stored as JSON in the `actions`
// prop and always read through parseButtonActions (buttonActions.ts).
import { useMemo, useState, type ReactNode } from 'react';
import { ActionIcon, Menu, Modal, SegmentedControl, Select, Switch, TextInput, Textarea } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { createReactBlockSpec } from '@blocknote/react';
import type { BlockNoteEditor } from '@blocknote/core';
import {
  ArrowDown,
  ArrowUp,
  CircleHelp,
  ExternalLink,
  ListPlus,
  MousePointerClick,
  PencilLine,
  Plus,
  Settings2,
  SmilePlus,
  TextCursorInput,
  Trash2,
  X,
} from 'lucide-react';
import {
  BUTTON_MAX_ACTIONS,
  BUTTON_MAX_INSERT_BLOCKS,
  EDITOR_BLOCK_TYPES,
  type ButtonAction,
  type ButtonPropertyValues,
  type DatabaseResponse,
  type PageDetailResponse,
  type PropertyDef,
  type PublicUser,
} from '@oriel/shared';
import { api } from '../lib/api';
import { qk } from '../lib/queryKeys';
import { queryClient } from '../lib/queryClient';
import { useSession } from '../lib/session';
import { useTree, ancestorsOf } from '../lib/tree';
import { confirmDialog, toast } from '../lib/ui';
import { pageTitle } from '../lib/util';
import { safeLinkUrl } from '../lib/safeUrl';
import { EmojiPickerPanel } from '../components/EmojiPicker';
import { isComputedType } from '../database/logic/values';
import {
  BUTTON_CONFIRM_ROWS,
  BUTTON_MAX_EDITED_ROWS,
  BUTTON_MAX_MESSAGE,
  ME_WORDS,
  buttonDatabaseProblem,
  buttonUpdate,
  buttonValue,
  countBlocks,
  filterRows,
  parseButtonActions,
  sanitizeInsertBlocks,
  serializeButtonActions,
  type ValueContext,
} from './buttonActions';
import { parseMarkdownWithMath, encodeMathBlocks } from './mathMarkdown';
import { openPageRef, useEditorEnv, type EditorEnv } from './env';

type AnyEditor = BlockNoteEditor<any, any, any>;

const DEFAULT_LABEL = 'Nouveau bouton';
const MAX_LABEL = 120;
const Z = 400;
const COMBO = { zIndex: Z + 100 };

/** Buttons whose settings open as soon as they are inserted (slash menu). */
export const openButtonOnMount = new Set<string>();

const propStr = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

// ---------------------------------------------------------------------------
// Running the actions
// ---------------------------------------------------------------------------

/**
 * Database of an action (the clicker's rights), refused unless it is a live database of the page's
 * workspace: the id comes from the shared document (QA-EDT-01, buttonDatabaseProblem). The write
 * requests then name the page of the button (`viaButtonOn`): the server refuses a database read by
 * fewer people than that page (QA-EDT-05); the page cached by the page view gives the same message first.
 */
async function databaseOf(did: string, env: EditorEnv, step: string): Promise<DatabaseResponse> {
  if (!env.pageId) throw new Error(`page du bouton inconnue${step}`);
  let db: DatabaseResponse;
  try {
    db = await queryClient.fetchQuery({ queryKey: ['button-database', did], queryFn: () => api.databases.get(did), staleTime: 10_000 });
  } catch (e) {
    throw new Error(`base introuvable ou inaccessible${step} : ${errorText(e)}`);
  }
  const host = queryClient.getQueryData<PageDetailResponse>(qk.page(env.pageId))?.page ?? null;
  const problem = buttonDatabaseProblem(db.page, env.workspaceId, host);
  if (problem) throw new Error(`${problem}${step}`);
  return db;
}

async function membersOf(wid: string | null): Promise<PublicUser[]> {
  if (!wid) return [];
  try {
    const members = await queryClient.fetchQuery({ queryKey: qk.members(wid), queryFn: () => api.workspaces.members(wid), staleTime: 60_000 });
    return members.map((m) => m.user);
  } catch {
    return [];
  }
}

const errorText = (e: unknown) => (e instanceof Error && e.message ? e.message : 'erreur inconnue');

/** Runs the actions in order; stops at the first refused confirmation or error. */
async function runActions(editor: AnyEditor, blockId: string, actions: ButtonAction[], env: EditorEnv, meId: string | null): Promise<void> {
  let after = blockId;
  let cx: ValueContext | null = null;
  const valueContext = async () => (cx ??= { users: await membersOf(env.workspaceId), meId, now: new Date() });
  for (const [i, action] of actions.entries()) {
    const step = actions.length > 1 ? ` (action ${i + 1})` : '';
    switch (action.type) {
      case 'confirm': {
        const ok = await confirmDialog({ title: action.message, confirmLabel: 'Continuer', cancelLabel: 'Annuler' });
        if (!ok) return;
        break;
      }
      case 'insert': {
        if (!editor.isEditable) throw new Error('la page n’est pas modifiable');
        const blocks = sanitizeInsertBlocks(action.blocks, (t) => t in editor.schema.blockSchema);
        if (blocks.length === 0) break;
        const ref = editor.getBlock(after) ?? editor.getBlock(blockId);
        if (!ref) throw new Error('le bouton a été supprimé');
        const inserted = editor.insertBlocks(blocks as never, ref, 'after');
        after = inserted[inserted.length - 1]?.id ?? after;
        break;
      }
      case 'addRow': {
        const db = await databaseOf(action.databaseId, env, step);
        const update = buttonUpdate(action.values, db.schema.properties, await valueContext());
        await api.databases.createRow(action.databaseId, { title: update.title, properties: update.properties, viaButtonOn: env.pageId });
        void queryClient.invalidateQueries({ queryKey: qk.rows(action.databaseId) });
        toast(`Ligne ajoutée à « ${pageTitle(db.page.title)} ».`);
        break;
      }
      case 'editRows': {
        const db = await databaseOf(action.databaseId, env, step);
        const ctx = await valueContext();
        const update = buttonUpdate(action.values, db.schema.properties, ctx);
        if (update.title === undefined && Object.keys(update.properties).length === 0) break;
        const { rows, users } = await api.databases.rows(action.databaseId);
        const targets = filterRows(rows, db.schema.properties, action.filter, [...ctx.users, ...users]).slice(0, BUTTON_MAX_EDITED_ROWS);
        if (targets.length === 0) {
          toast(`Aucune ligne à modifier dans « ${pageTitle(db.page.title)} ».`);
          break;
        }
        if (targets.length > BUTTON_CONFIRM_ROWS) {
          const ok = await confirmDialog({
            title: `Modifier ${targets.length} lignes ?`,
            message: `Le bouton va modifier ${targets.length} lignes de « ${pageTitle(db.page.title)} ».`,
            confirmLabel: 'Modifier',
          });
          if (!ok) return;
        }
        const body = update.title === undefined ? { properties: update.properties } : { title: update.title, properties: update.properties };
        // One request (at most BUTTON_MAX_EDITED_ROWS = 500 rows, all or nothing), checked by the
        // server with the clicker's rights and against the page of the button (QA-EDT-05).
        try {
          await api.databases.updateRowsBatch(action.databaseId, { updates: targets.map((row) => ({ id: row.id, ...body })), viaButtonOn: env.pageId });
        } catch (e) {
          throw new Error(`aucune ligne modifiée${step} : ${errorText(e)}`);
        } finally {
          void queryClient.invalidateQueries({ queryKey: qk.rows(action.databaseId) });
        }
        toast(`${targets.length} ligne${targets.length > 1 ? 's' : ''} modifiée${targets.length > 1 ? 's' : ''}.`);
        break;
      }
      case 'open': {
        if (action.pageId) openPageRef(env, action.pageId);
        else {
          const url = safeLinkUrl(action.url);
          if (url) window.open(url, '_blank', 'noopener,noreferrer');
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Summary of the actions (tooltip, settings)
// ---------------------------------------------------------------------------

function actionSummary(a: ButtonAction, titleOf: (id: string) => string): string {
  switch (a.type) {
    case 'insert': {
      const n = countBlocks(a.blocks);
      return `Insérer ${n} bloc${n > 1 ? 's' : ''}`;
    }
    case 'addRow':
      return `Ajouter une ligne à « ${titleOf(a.databaseId)} »`;
    case 'editRows':
      return `Modifier ${a.filter ? 'des lignes' : 'toutes les lignes'} de « ${titleOf(a.databaseId)} »`;
    case 'open':
      return a.pageId ? `Ouvrir « ${titleOf(a.pageId)} »` : `Ouvrir ${a.url}`;
    case 'confirm':
      return `Demander : « ${a.message} »`;
  }
}

// ---------------------------------------------------------------------------
// Block view
// ---------------------------------------------------------------------------

function ButtonView({ block, editor }: { block: { id: string; props: Record<string, unknown> }; editor: AnyEditor }) {
  const env = useEditorEnv();
  const session = useSession();
  const tree = useTree(env.mode === 'app' ? (env.workspaceId ?? undefined) : undefined);
  const user = session.data?.user ?? null;
  const label = propStr(block.props.label, MAX_LABEL).trim() || DEFAULT_LABEL;
  const icon = propStr(block.props.icon, 16);
  const rawActions = block.props.actions;
  const actions = useMemo(() => parseButtonActions(rawActions), [rawActions]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(() => openButtonOnMount.delete(block.id));
  // Anonymous visitors, published pages, read-only access: never runs.
  const enabled = env.mode === 'app' && env.canEdit && !!user;
  const titleOf = (id: string) => pageTitle(tree.index.byId.get(id)?.title);
  const summary = actions.length ? actions.map((a, i) => `${i + 1}. ${actionSummary(a, titleOf)}`).join('\n') : 'Aucune action';

  const run = async () => {
    if (!enabled || busy) return;
    if (actions.length === 0) {
      setEditing(true);
      return;
    }
    setBusy(true);
    try {
      await runActions(editor, block.id, actions, env, user?.id ?? null);
    } catch (e) {
      toast(`Le bouton s’est arrêté : ${errorText(e)}`, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="or-button-block" contentEditable={false}>
      <button
        type="button"
        className="or-button"
        disabled={!enabled || busy}
        aria-busy={busy || undefined}
        title={enabled ? summary : env.mode === 'app' ? 'Bouton inactif en lecture seule' : 'Bouton inactif sur une page publique'}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => void run()}
      >
        <span className="or-button__icon" aria-hidden>
          {icon || <MousePointerClick size={15} />}
        </span>
        <span className="or-button__label">{label}</span>
      </button>
      {enabled && (
        <button type="button" className="or-button-block__settings" aria-label="Configurer le bouton" title="Configurer le bouton" onClick={() => setEditing(true)}>
          <Settings2 size={15} />
        </button>
      )}
      {editing && enabled && (
        <ButtonSettings
          editor={editor}
          blockId={block.id}
          label={propStr(block.props.label, MAX_LABEL)}
          icon={icon}
          actions={actions}
          workspaceId={env.workspaceId}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}

export const ButtonBlock = createReactBlockSpec(
  {
    type: EDITOR_BLOCK_TYPES.button,
    propSchema: { label: { default: DEFAULT_LABEL }, icon: { default: '' }, actions: { default: '[]' } },
    content: 'none',
  },
  {
    render: ({ block, editor }) => <ButtonView block={block as never} editor={editor as AnyEditor} />,
    // Interactive only: HTML copies show the label (Markdown export leaves the button out).
    toExternalHTML: ({ block }) => <p>{propStr(block.props.label, MAX_LABEL).trim() || DEFAULT_LABEL}</p>,
  },
);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface Draft {
  key: number;
  action: ButtonAction;
  /** Insert actions: blocks edited as Markdown (the recorded blocks stay as they are until it changes). */
  markdown?: string;
  markdownChanged?: boolean;
}

let draftKey = 0;

const NEW_ACTIONS: Array<{ type: ButtonAction['type']; label: string; hint: string; icon: ReactNode }> = [
  { type: 'insert', label: 'Insérer des blocs', hint: 'Ajoute du contenu sous le bouton', icon: <TextCursorInput size={15} /> },
  { type: 'addRow', label: 'Ajouter une ligne', hint: 'Crée une ligne dans une base', icon: <ListPlus size={15} /> },
  { type: 'editRows', label: 'Modifier des lignes', hint: 'Change des valeurs dans une base', icon: <PencilLine size={15} /> },
  { type: 'open', label: 'Ouvrir une page ou un lien', hint: 'Page de l’espace ou adresse web', icon: <ExternalLink size={15} /> },
  { type: 'confirm', label: 'Demander une confirmation', hint: 'La suite ne s’exécute que si on accepte', icon: <CircleHelp size={15} /> },
];

const ACTION_LABEL: Record<ButtonAction['type'], string> = Object.fromEntries(NEW_ACTIONS.map((a) => [a.type, a.label])) as Record<ButtonAction['type'], string>;
const ACTION_ICON: Record<ButtonAction['type'], ReactNode> = Object.fromEntries(NEW_ACTIONS.map((a) => [a.type, a.icon])) as Record<ButtonAction['type'], ReactNode>;

function blankAction(type: ButtonAction['type']): ButtonAction {
  switch (type) {
    case 'insert':
      return { type, blocks: [] };
    case 'addRow':
      return { type, databaseId: '', values: {} };
    case 'editRows':
      return { type, databaseId: '', filter: null, values: {} };
    case 'open':
      return { type, url: '' };
    case 'confirm':
      return { type, message: 'Continuer ?' };
  }
}

/** Markdown of recorded blocks (to edit them as text). */
function blocksToMarkdown(editor: AnyEditor, blocks: unknown[]): string {
  if (blocks.length === 0) return '';
  try {
    const known = sanitizeInsertBlocks(blocks, (t) => t in editor.schema.blockSchema);
    const math = encodeMathBlocks(known as Array<{ type?: string }>);
    return math.decode(editor.blocksToMarkdownLossy(math.blocks as never)).trim();
  } catch {
    return '';
  }
}

function ButtonSettings({
  editor,
  blockId,
  label: initialLabel,
  icon: initialIcon,
  actions: initialActions,
  workspaceId,
  onClose,
}: {
  editor: AnyEditor;
  blockId: string;
  label: string;
  icon: string;
  actions: ButtonAction[];
  workspaceId: string | null;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(initialLabel);
  const [icon, setIcon] = useState(initialIcon);
  const [pickIcon, setPickIcon] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    initialActions.map((action) => ({ key: ++draftKey, action, markdown: action.type === 'insert' ? blocksToMarkdown(editor, action.blocks) : undefined })),
  );
  const tree = useTree(workspaceId ?? undefined);

  const pages = useMemo(() => {
    const out: Array<{ value: string; label: string; kind: string }> = [];
    for (const n of tree.index.byId.values()) {
      const path = ancestorsOf(tree.index, n.id)
        .map((a) => pageTitle(a.title))
        .concat(pageTitle(n.title))
        .join(' / ');
      out.push({ value: n.id, label: path, kind: n.kind });
    }
    return out.sort((a, b) => a.label.localeCompare(b.label, 'fr'));
  }, [tree.index]);
  const databases = useMemo(() => pages.filter((p) => p.kind === 'database'), [pages]);

  const update = (key: number, patch: Partial<Draft>) => setDrafts((list) => list.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  const setAction = (key: number, action: ButtonAction) => update(key, { action });
  const move = (i: number, dir: -1 | 1) =>
    setDrafts((list) => {
      const j = i + dir;
      if (j < 0 || j >= list.length) return list;
      const next = [...list];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  const problems = drafts.map((d) => draftProblem(d));
  const valid = problems.every((p) => !p);

  const save = () => {
    if (!valid) return;
    const actions = drafts.map((d): ButtonAction => {
      if (d.action.type !== 'insert' || !d.markdownChanged) return d.action;
      let blocks: unknown[] = [];
      try {
        blocks = parseMarkdownWithMath((d.markdown ?? '').trim(), (md) => (md ? (editor.tryParseMarkdownToBlocks(md) as never[]) : []));
      } catch {
        blocks = [];
      }
      return { type: 'insert', blocks: sanitizeInsertBlocks(blocks, (t) => t in editor.schema.blockSchema) };
    });
    const block = editor.getBlock(blockId);
    if (!block) return onClose();
    editor.updateBlock(block, { props: { label: label.trim().slice(0, MAX_LABEL) || DEFAULT_LABEL, icon: icon.slice(0, 16), actions: serializeButtonActions(actions) } } as never);
    onClose();
  };

  return (
    <Modal opened onClose={onClose} title="Configurer le bouton" centered size="lg" zIndex={Z} classNames={{ body: 'or-button-settings' }}>
      <div className="or-button-settings__head">
        <div className="or-button-settings__icon">
          <button type="button" className="or-button-settings__icon-btn" aria-label="Choisir une icône" title="Choisir une icône" onClick={() => setPickIcon((o) => !o)}>
            {icon || <SmilePlus size={18} />}
          </button>
          {icon && (
            <button type="button" className="or-button-settings__icon-clear" aria-label="Retirer l’icône" title="Retirer l’icône" onClick={() => setIcon('')}>
              <X size={12} />
            </button>
          )}
        </div>
        <TextInput
          className="or-button-settings__label"
          label="Libellé"
          placeholder={DEFAULT_LABEL}
          value={label}
          maxLength={MAX_LABEL}
          data-autofocus
          onChange={(e) => setLabel(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
      </div>
      {pickIcon && (
        <div className="or-button-settings__picker">
          <EmojiPickerPanel
            onSelect={(e) => {
              setIcon(e);
              setPickIcon(false);
            }}
          />
        </div>
      )}

      <div className="or-button-settings__section">Quand on clique</div>
      {drafts.length === 0 && <div className="or-button-settings__empty">Aucune action pour l’instant. Ajoutez-en une ci-dessous.</div>}
      <ol className="or-button-actions">
        {drafts.map((d, i) => (
          <li key={d.key} className="or-button-action">
            <div className="or-button-action__head">
              <span className="or-button-action__num">{i + 1}</span>
              <span className="or-button-action__icon">{ACTION_ICON[d.action.type]}</span>
              <span className="or-button-action__title">{ACTION_LABEL[d.action.type]}</span>
              <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Monter" disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp size={14} />
              </ActionIcon>
              <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Descendre" disabled={i === drafts.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown size={14} />
              </ActionIcon>
              <ActionIcon variant="subtle" color="red" size="sm" aria-label="Supprimer l’action" onClick={() => setDrafts((list) => list.filter((x) => x.key !== d.key))}>
                <Trash2 size={14} />
              </ActionIcon>
            </div>
            <div className="or-button-action__body">
              <ActionFields draft={d} pages={pages} databases={databases} workspaceId={workspaceId} onChange={(patch) => update(d.key, patch)} setAction={(a) => setAction(d.key, a)} />
              {problems[i] && <div className="or-button-action__problem">{problems[i]}</div>}
            </div>
          </li>
        ))}
      </ol>
      <Menu position="bottom-start" withinPortal zIndex={Z + 100} disabled={drafts.length >= BUTTON_MAX_ACTIONS}>
        <Menu.Target>
          <button type="button" className="btn btn--sm or-button-settings__add" disabled={drafts.length >= BUTTON_MAX_ACTIONS}>
            <Plus size={14} /> Ajouter une action
          </button>
        </Menu.Target>
        <Menu.Dropdown>
          {NEW_ACTIONS.map((a) => (
            <Menu.Item key={a.type} leftSection={a.icon} onClick={() => setDrafts((list) => [...list, { key: ++draftKey, action: blankAction(a.type), markdown: a.type === 'insert' ? '' : undefined }])}>
              <div>{a.label}</div>
              <div className="or-button-settings__hint">{a.hint}</div>
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>

      <div className="or-button-settings__footer">
        <span className="or-button-settings__note">Les actions s’exécutent avec les droits de la personne qui clique.</span>
        <button type="button" className="btn btn--sm" onClick={onClose}>
          Annuler
        </button>
        <button type="button" className="btn btn--primary btn--sm" disabled={!valid} onClick={save}>
          Enregistrer
        </button>
      </div>
    </Modal>
  );
}

/** What prevents saving an action, or null. */
function draftProblem(d: Draft): string | null {
  const a = d.action;
  switch (a.type) {
    case 'insert': {
      if (d.markdownChanged ? !(d.markdown ?? '').trim() : a.blocks.length === 0) return 'Écrivez le contenu à insérer.';
      return null;
    }
    case 'addRow':
    case 'editRows':
      return a.databaseId ? null : 'Choisissez une base de données.';
    case 'open':
      if (a.pageId) return null;
      return safeLinkUrl(a.url) ? null : 'Indiquez une page ou une adresse commençant par https://, http://, mailto: ou tel:.';
    case 'confirm':
      return a.message.trim() ? null : 'Écrivez la question à poser.';
  }
}

function ActionFields({
  draft,
  pages,
  databases,
  workspaceId,
  onChange,
  setAction,
}: {
  draft: Draft;
  pages: Array<{ value: string; label: string }>;
  databases: Array<{ value: string; label: string }>;
  workspaceId: string | null;
  onChange: (patch: Partial<Draft>) => void;
  setAction: (a: ButtonAction) => void;
}) {
  const a = draft.action;
  switch (a.type) {
    case 'insert': {
      const lines = (draft.markdown ?? '').split('\n').length;
      return (
        <>
          <Textarea
            label="Contenu inséré sous le bouton"
            description="En Markdown : # titre, - liste, [ ] case à cocher, > citation, $x^2$ équation…"
            autosize
            minRows={3}
            maxRows={14}
            value={draft.markdown ?? ''}
            onChange={(e) => onChange({ markdown: e.currentTarget.value, markdownChanged: true })}
            styles={{ input: { fontFamily: 'var(--font-mono, monospace)', fontSize: 13 } }}
          />
          <div className="or-button-settings__hint">
            {draft.markdownChanged ? `${lines} ligne${lines > 1 ? 's' : ''}` : `${countBlocks(a.blocks)} bloc${countBlocks(a.blocks) > 1 ? 's' : ''} enregistré${countBlocks(a.blocks) > 1 ? 's' : ''}`} · {BUTTON_MAX_INSERT_BLOCKS} blocs au plus
          </div>
        </>
      );
    }
    case 'addRow':
    case 'editRows':
      return <RowActionFields action={a} databases={databases} workspaceId={workspaceId} setAction={setAction} />;
    case 'open': {
      const mode = a.pageId !== undefined ? 'page' : 'url';
      return (
        <>
          <SegmentedControl
            size="xs"
            value={mode}
            onChange={(v) => setAction(v === 'page' ? { type: 'open', pageId: '' } : { type: 'open', url: '' })}
            data={[
              { value: 'page', label: 'Une page' },
              { value: 'url', label: 'Un lien' },
            ]}
          />
          {mode === 'page' ? (
            <Select
              mt={8}
              placeholder="Choisir une page…"
              searchable
              nothingFoundMessage="Aucune page"
              data={pages}
              value={a.pageId || null}
              onChange={(v) => setAction({ type: 'open', pageId: v ?? '' })}
              comboboxProps={COMBO}
            />
          ) : (
            <TextInput
              mt={8}
              placeholder="https://…"
              value={a.url ?? ''}
              onChange={(e) => setAction({ type: 'open', url: e.currentTarget.value })}
              error={a.url && !safeLinkUrl(a.url) ? 'Adresse non autorisée' : undefined}
            />
          )}
        </>
      );
    }
    case 'confirm':
      return (
        <TextInput
          label="Question"
          placeholder="Continuer ?"
          maxLength={BUTTON_MAX_MESSAGE}
          value={a.message}
          onChange={(e) => setAction({ type: 'confirm', message: e.currentTarget.value })}
        />
      );
  }
}

/** Database, filter (editRows) and preset values of a row action. */
function RowActionFields({
  action,
  databases,
  workspaceId,
  setAction,
}: {
  action: Extract<ButtonAction, { type: 'addRow' | 'editRows' }>;
  databases: Array<{ value: string; label: string }>;
  workspaceId: string | null;
  setAction: (a: ButtonAction) => void;
}) {
  const db = useQuery({
    queryKey: ['button-database', action.databaseId],
    queryFn: () => api.databases.get(action.databaseId),
    enabled: !!action.databaseId,
    retry: false,
    staleTime: 10_000,
  });
  const members = useQuery({ queryKey: qk.members(workspaceId ?? ''), queryFn: () => api.workspaces.members(workspaceId!), enabled: !!workspaceId, staleTime: 60_000 });
  const session = useSession();
  const properties = db.data?.schema.properties ?? [];
  const writable = properties.filter((p) => !isComputedType(p.type) && p.type !== 'files' && p.type !== 'relation');
  const cx: ValueContext = { users: (members.data ?? []).map((m) => m.user), meId: session.data?.user?.id ?? null, now: new Date() };

  const setValues = (values: ButtonPropertyValues) => setAction({ ...action, values });
  const entries = Object.entries(action.values);
  const filterable = properties.filter((p) => !['files', 'relation', 'formula', 'rollup'].includes(p.type));

  return (
    <>
      <Select
        label="Base de données"
        placeholder="Choisir une base…"
        searchable
        nothingFoundMessage="Aucune base dans cet espace"
        data={databases}
        value={action.databaseId || null}
        onChange={(v) => {
          if (!v || v === action.databaseId) return;
          setAction(action.type === 'addRow' ? { type: 'addRow', databaseId: v, values: {} } : { type: 'editRows', databaseId: v, filter: null, values: {} });
        }}
        allowDeselect={false}
        comboboxProps={COMBO}
      />
      {db.isError && <div className="or-button-action__problem">Base inaccessible.</div>}
      {action.databaseId && db.data && (
        <>
          {action.type === 'editRows' && (
            <div className="or-button-filter">
              <Switch
                size="xs"
                label="Seulement les lignes où…"
                checked={!!action.filter}
                onChange={(e) => {
                  const first = filterable.find((p) => p.type !== 'title') ?? filterable[0];
                  setAction({ ...action, filter: e.currentTarget.checked && first ? { propertyId: first.id, value: '' } : null });
                }}
              />
              {action.filter && (
                <div className="or-button-value">
                  <Select
                    size="xs"
                    data={filterable.map((p) => ({ value: p.id, label: p.name }))}
                    value={action.filter.propertyId}
                    onChange={(v) => v && setAction({ ...action, filter: { propertyId: v, value: '' } })}
                    comboboxProps={COMBO}
                    allowDeselect={false}
                  />
                  <span className="or-button-value__eq">vaut</span>
                  <ValueInput
                    prop={properties.find((p) => p.id === action.filter!.propertyId)}
                    value={action.filter.value}
                    onChange={(value) => setAction({ ...action, filter: { ...action.filter!, value } })}
                    placeholder="(vide)"
                  />
                </div>
              )}
            </div>
          )}
          <div className="or-button-settings__sub">{action.type === 'addRow' ? 'Valeurs de la nouvelle ligne' : 'Nouvelles valeurs'}</div>
          {entries.map(([propId, raw]) => {
            const prop = properties.find((p) => p.id === propId);
            const unknown = prop && prop.type !== 'title' && raw.trim() !== '' && buttonValue(prop, raw, cx) === undefined;
            return (
              <div key={propId} className="or-button-value">
                <Select
                  size="xs"
                  data={writable.filter((p) => p.id === propId || !(p.id in action.values)).map((p) => ({ value: p.id, label: p.name }))}
                  value={prop ? propId : null}
                  placeholder="Propriété supprimée"
                  onChange={(v) => {
                    if (!v || v === propId) return;
                    const next: ButtonPropertyValues = {};
                    for (const [k, val] of entries) next[k === propId ? v : k] = k === propId ? '' : val;
                    setValues(next);
                  }}
                  comboboxProps={COMBO}
                  allowDeselect={false}
                />
                <span className="or-button-value__eq">=</span>
                <ValueInput prop={prop} value={raw} onChange={(value) => setValues({ ...action.values, [propId]: value })} error={unknown ? 'Valeur non reconnue' : undefined} />
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size="sm"
                  aria-label="Retirer la valeur"
                  onClick={() => setValues(Object.fromEntries(entries.filter(([k]) => k !== propId)))}
                >
                  <X size={14} />
                </ActionIcon>
              </div>
            );
          })}
          {writable.some((p) => !(p.id in action.values)) && (
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => {
                const next = writable.find((p) => !(p.id in action.values));
                if (next) setValues({ ...action.values, [next.id]: '' });
              }}
            >
              <Plus size={13} /> Définir une valeur
            </button>
          )}
        </>
      )}
    </>
  );
}

const CHECK_CHOICES = [
  { value: 'oui', label: 'Coché' },
  { value: 'non', label: 'Non coché' },
];

/** Text value of a property, with the choices of option and checkbox properties. */
function ValueInput({ prop, value, onChange, placeholder, error }: { prop: PropertyDef | undefined; value: string; onChange: (v: string) => void; placeholder?: string; error?: string }) {
  if (prop && (prop.type === 'select' || prop.type === 'status')) {
    return (
      <Select
        size="xs"
        className="or-button-value__input"
        data={(prop.options ?? []).map((o) => ({ value: o.name, label: o.name }))}
        value={value || null}
        placeholder={placeholder ?? '(vide)'}
        onChange={(v) => onChange(v ?? '')}
        comboboxProps={COMBO}
        clearable
        searchable
      />
    );
  }
  if (prop?.type === 'checkbox') {
    return (
      <Select size="xs" className="or-button-value__input" data={CHECK_CHOICES} value={['oui', 'non'].includes(value) ? value : null} onChange={(v) => onChange(v ?? '')} comboboxProps={COMBO} placeholder="Choisir…" />
    );
  }
  const hint =
    prop?.type === 'date'
      ? 'aujourd’hui, maintenant ou 2026-10-15'
      : prop?.type === 'person'
        ? `${ME_WORDS[0]} ou un nom`
        : prop?.type === 'multi_select'
          ? 'Option 1, Option 2'
          : prop?.type === 'number'
            ? '12,5'
            : undefined;
  return <TextInput size="xs" className="or-button-value__input" value={value} placeholder={placeholder ?? hint ?? '(vide)'} onChange={(e) => onChange(e.currentTarget.value)} error={error} />;
}
