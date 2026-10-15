// Person, files and relation editors.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ExternalLink, FileText, Link as LinkIcon, Loader, Plus, Upload, X } from 'lucide-react';
import type { FileValue, PropertyDef } from '@oriel/shared';
import { navigation } from '../../../lib/navigation';
import { useDb } from '../../context';
import { useRowsQuery, useTemplatesQuery } from '../../data';
import { formatFileSize } from '../../logic/format';
import { normalizeText } from '../../logic/text';
import { isImageFile } from '../ValueDisplay';
import { Avatar, cx, IconBtn, MenuDivider, UserChip } from '../primitives';

function useListKeys(count: number, onEnter: (index: number) => void) {
  const [highlight, setHighlight] = useState(0);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => (count ? (h + 1) % count : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => (count ? (h - 1 + count) % count : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (count) onEnter(Math.min(highlight, count - 1));
    }
  };
  return { highlight, setHighlight, onKeyDown };
}

// ---------------------------------------------------------------------------
// Person
// ---------------------------------------------------------------------------

export function PersonEditor({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const { members, ctx } = useDb();
  const [query, setQuery] = useState('');
  const q = normalizeText(query.trim());
  const list = useMemo(() => {
    const known = new Map(members.map((u) => [u.id, u]));
    for (const id of value) if (!known.has(id) && ctx.users.get(id)) known.set(id, ctx.users.get(id)!);
    return [...known.values()]
      .filter((u) => !q || normalizeText(`${u.name} ${u.email}`).includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  }, [members, ctx.users, value, q]);
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  const keys = useListKeys(list.length, (i) => toggle(list[i]!.id));
  useEffect(() => keys.setHighlight(0), [query]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="ordb-picker">
      <div className="ordb-token-field">
        {value.map((id) => (
          <span key={id} className="ordb-token">
            <UserChip id={id} user={ctx.users.get(id)} />
            <button type="button" className="ordb-tag-remove" aria-label="Retirer" onClick={() => toggle(id)}>
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          className="ordb-token-input"
          placeholder="Rechercher une personne…"
          aria-label="Rechercher une personne"
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !query && value.length) onChange(value.slice(0, -1));
            else keys.onKeyDown(e);
          }}
        />
      </div>
      <div className="ordb-options-list" role="listbox" aria-multiselectable>
        {list.length === 0 && <div className="ordb-menu-empty">Aucun membre trouvé</div>}
        {list.map((u, i) => (
          <button
            type="button"
            key={u.id}
            role="option"
            aria-selected={value.includes(u.id)}
            className={cx('ordb-option-row', keys.highlight === i && 'is-highlighted')}
            onMouseEnter={() => keys.setHighlight(i)}
            onClick={() => toggle(u.id)}
          >
            <Avatar user={u} size={22} />
            <span className="ordb-person-text">
              <span>{u.name}</span>
              <span className="ordb-muted">{u.email}</span>
            </span>
            <span className="ordb-option-spacer" />
            {value.includes(u.id) && <Check size={14} className="ordb-option-check" />}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export function FilesEditor({ value, onChange }: { value: FileValue[]; onChange: (files: FileValue[]) => void }) {
  const { m, workspaceId } = useDb();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [link, setLink] = useState('');
  const latest = useRef(value);
  latest.current = value;

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    const list = [...files];
    setUploading((n) => n + list.length);
    for (const f of list) {
      const uploaded = await m.uploadFile(workspaceId, f);
      setUploading((n) => n - 1);
      if (uploaded) {
        latest.current = [...latest.current, uploaded];
        onChange(latest.current);
      }
    }
  };

  const addLink = () => {
    const url = link.trim();
    if (!/^https?:\/\//i.test(url)) return;
    const name = url.replace(/^https?:\/\//i, '').split(/[?#]/)[0]!.split('/').filter(Boolean).pop() || url;
    onChange([...value, { name, url }]);
    setLink('');
  };

  return (
    <div className="ordb-picker ordb-files-editor">
      {value.length === 0 && uploading === 0 && <div className="ordb-menu-empty">Aucun fichier</div>}
      <div className="ordb-file-list">
        {value.map((f, i) => (
          <div key={`${f.url}-${i}`} className="ordb-file-row">
            {isImageFile(f) ? <img src={f.url} alt="" className="ordb-file-mini" /> : <FileText size={16} />}
            <a href={f.url} target="_blank" rel="noopener noreferrer" className="ordb-file-name" title={f.name}>
              {f.name}
            </a>
            <span className="ordb-muted">{formatFileSize(f.size)}</span>
            <IconBtn label={`Retirer ${f.name}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <X size={14} />
            </IconBtn>
          </div>
        ))}
        {uploading > 0 && (
          <div className="ordb-file-row ordb-muted">
            <Loader size={14} className="ordb-spin" /> Envoi en cours…
          </div>
        )}
      </div>
      <MenuDivider />
      <div className="ordb-panel-body">
        <button type="button" className="ordb-btn is-outline is-md ordb-full" onClick={() => input.current?.click()}>
          <Upload size={14} /> Envoyer un fichier
        </button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void upload(e.target.files);
            e.target.value = '';
          }}
        />
        <div className="ordb-link-add">
          <LinkIcon size={14} className="ordb-muted" />
          <input
            className="ordb-input"
            placeholder="Coller un lien (https://…)"
            aria-label="Ajouter un lien"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addLink();
              }
            }}
          />
          <IconBtn label="Ajouter le lien" onClick={addLink} disabled={!/^https?:\/\//i.test(link.trim())}>
            <Plus size={14} />
          </IconBtn>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Relation
// ---------------------------------------------------------------------------

export function RelationEditor({
  prop,
  value,
  onChange,
  canCreate,
  onDone,
}: {
  prop: PropertyDef;
  value: string[];
  onChange: (ids: string[]) => void;
  canCreate: boolean;
  /** Called after picking a page of a single-page relation. */
  onDone?: () => void;
}) {
  const single = !!prop.relation?.singlePage;
  const { publicMode, m, related, hostPageId, canEdit } = useDb();
  const target = prop.relation?.databaseId ?? '';
  const rowsQ = useRowsQuery(target, publicMode, !!target);
  // I1: « Cette page » — a row inside a template's content may point at that template; the link follows
  // the new row when the template is used (rows of the target are listed as usual).
  const hostTemplate = (useTemplatesQuery(target, !!target && !!hostPageId && canEdit).data?.rows ?? []).find((t) => t.id === hostPageId);
  const [query, setQuery] = useState('');
  const q = normalizeText(query.trim());
  const rows = rowsQ.data?.rows ?? [];
  const selectedSet = new Set(value);
  const candidates = useMemo(
    () => rows.filter((r) => !selectedSet.has(r.id) && (!q || normalizeText(r.title).includes(q))).slice(0, 60),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, q, value],
  );
  const toggle = (id: string) => {
    if (selectedSet.has(id)) return onChange(value.filter((x) => x !== id));
    if (single) {
      onChange([id]);
      onDone?.();
      return;
    }
    onChange([...value, id]);
  };
  const exact = rows.some((r) => normalizeText(r.title) === q);
  const showCreate = canCreate && q !== '' && !exact;
  const keys = useListKeys(candidates.length + (showCreate ? 1 : 0), (i) => {
    if (i < candidates.length) toggle(candidates[i]!.id);
    else void create();
  });
  useEffect(() => keys.setHighlight(0), [query]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    const title = query.trim();
    if (!title || !target) return;
    setQuery('');
    const page = await m.createRowIn(target, title);
    if (!page) return;
    if (single) {
      onChange([page.id]);
      onDone?.();
    } else onChange([...value, page.id]);
  };

  if (!target) {
    return (
      <div className="ordb-picker">
        <div className="ordb-menu-empty">Aucune base liée. Choisissez-la dans le menu de la propriété.</div>
      </div>
    );
  }

  // Ids absent from the loaded target rows are trashed rows (kept, restored with them): not listed.
  const shown = rowsQ.isSuccess ? value.filter((id) => rows.some((r) => r.id === id) || id === hostTemplate?.id) : value;
  const titleOf = (id: string) => {
    if (id === hostTemplate?.id) return 'Cette page';
    const r = rows.find((x) => x.id === id) ?? related.get(id);
    return r ? r.title || 'Sans titre' : 'Page inaccessible';
  };
  const iconOf = (id: string) => (rows.find((x) => x.id === id) ?? related.get(id))?.icon ?? null;

  return (
    <div className="ordb-picker">
      <input
        className="ordb-input ordb-picker-search"
        placeholder="Rechercher une page…"
        aria-label="Rechercher une page liée"
        value={query}
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={keys.onKeyDown}
      />
      {shown.length > 0 && (
        <>
          <div className="ordb-menu-label">Pages liées</div>
          <div className="ordb-options-list">
            {shown.map((id) => (
              <div key={id} className="ordb-option-row is-selected">
                {iconOf(id) ? <span className="ordb-emoji">{iconOf(id)}</span> : <FileText size={14} />}
                <span className="ordb-ellipsis">{titleOf(id)}</span>
                <span className="ordb-option-spacer" />
                <IconBtn label="Ouvrir" onClick={() => navigation.openPeek(id)}>
                  <ExternalLink size={13} />
                </IconBtn>
                <IconBtn label="Retirer le lien" onClick={() => toggle(id)}>
                  <X size={13} />
                </IconBtn>
              </div>
            ))}
          </div>
          <MenuDivider />
        </>
      )}
      <div className="ordb-menu-label">{q ? 'Résultats' : single && shown.length ? 'Remplacer par' : 'Ajouter un lien'}</div>
      <div className="ordb-options-list">
        {rowsQ.isLoading && <div className="ordb-menu-empty">Chargement…</div>}
        {rowsQ.isError && <div className="ordb-menu-empty">Base liée inaccessible</div>}
        {hostTemplate && !selectedSet.has(hostTemplate.id) && !q && (
          <button type="button" className="ordb-option-row" onClick={() => toggle(hostTemplate.id)} title="Devient la nouvelle ligne quand le modèle est utilisé">
            <FileText size={14} />
            <span className="ordb-ellipsis">Cette page (modèle « {hostTemplate.title || 'Sans titre'} »)</span>
          </button>
        )}
        {candidates.map((r, i) => (
          <button
            type="button"
            key={r.id}
            className={cx('ordb-option-row', keys.highlight === i && 'is-highlighted')}
            onMouseEnter={() => keys.setHighlight(i)}
            onClick={() => toggle(r.id)}
          >
            {r.icon ? <span className="ordb-emoji">{r.icon}</span> : <FileText size={14} />}
            <span className="ordb-ellipsis">{r.title || 'Sans titre'}</span>
          </button>
        ))}
        {!rowsQ.isLoading && candidates.length === 0 && !showCreate && <div className="ordb-menu-empty">Aucune page</div>}
        {showCreate && (
          <button
            type="button"
            className={cx('ordb-option-row', 'is-create', keys.highlight === candidates.length && 'is-highlighted')}
            onMouseEnter={() => keys.setHighlight(candidates.length)}
            onClick={() => void create()}
          >
            <Plus size={14} />
            <span>
              Créer la page « {query.trim()} »
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
