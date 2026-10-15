// Original emoji picker built on @emoji-mart/data: search, categories, random, remove.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Popover } from '@mantine/core';
import {
  Activity,
  Apple,
  Clock,
  FaceSlightlySmiling,
  Flag,
  Hash,
  Leaf,
  Lightbulb,
  Plane,
  Search,
  Shuffle,
  Trash,
} from 'lucide-react';
import type { EmojiMartData } from '@emoji-mart/data';
import { storage } from '../lib/store';
import { normalizeText } from '../lib/util';
import './emoji-picker.css';

let dataCache: EmojiMartData | null = null;
let dataPromise: Promise<EmojiMartData> | null = null;

export function loadEmojiData(): Promise<EmojiMartData> {
  if (dataCache) return Promise.resolve(dataCache);
  if (!dataPromise) {
    dataPromise = import('@emoji-mart/data').then((m) => {
      dataCache = ((m as unknown as { default?: EmojiMartData }).default ?? (m as unknown as EmojiMartData)) as EmojiMartData;
      return dataCache;
    });
  }
  return dataPromise;
}

const CATEGORY_META: Record<string, { label: string; icon: ReactNode }> = {
  recent: { label: 'Récents', icon: <Clock size={16} /> },
  people: { label: 'Smileys et personnes', icon: <FaceSlightlySmiling size={16} /> },
  nature: { label: 'Animaux et nature', icon: <Leaf size={16} /> },
  foods: { label: 'Nourriture et boissons', icon: <Apple size={16} /> },
  activity: { label: 'Activités', icon: <Activity size={16} /> },
  places: { label: 'Voyages et lieux', icon: <Plane size={16} /> },
  objects: { label: 'Objets', icon: <Lightbulb size={16} /> },
  symbols: { label: 'Symboles', icon: <Hash size={16} /> },
  flags: { label: 'Drapeaux', icon: <Flag size={16} /> },
};

// A few French search terms mapped to English keywords of the data set.
const FRENCH_ALIASES: Record<string, string[]> = {
  coeur: ['heart'],
  etoile: ['star'],
  feu: ['fire'],
  livre: ['book'],
  maison: ['house', 'home'],
  soleil: ['sun'],
  lune: ['moon'],
  neige: ['snow'],
  glace: ['ice'],
  arbre: ['tree'],
  fleur: ['flower'],
  chat: ['cat'],
  chien: ['dog'],
  sourire: ['smile', 'grin'],
  rire: ['laugh', 'joy'],
  triste: ['sad', 'cry'],
  fusee: ['rocket'],
  idee: ['bulb', 'idea'],
  ampoule: ['bulb'],
  calendrier: ['calendar'],
  note: ['memo', 'note'],
  crayon: ['pencil'],
  ordinateur: ['computer', 'laptop'],
  telephone: ['phone'],
  argent: ['money', 'dollar'],
  travail: ['work', 'briefcase'],
  musique: ['music'],
  voiture: ['car'],
  avion: ['airplane', 'plane'],
  cafe: ['coffee'],
  pomme: ['apple'],
  drapeau: ['flag'],
  coche: ['check'],
  attention: ['warning'],
  cible: ['target', 'dart'],
  graphique: ['chart'],
  dossier: ['folder'],
  cle: ['key'],
  cadenas: ['lock'],
  outil: ['tool', 'hammer', 'wrench'],
  pingouin: ['penguin'],
  ours: ['bear'],
  poisson: ['fish'],
  montagne: ['mountain'],
  mer: ['ocean', 'wave'],
  eau: ['water', 'droplet'],
  cadeau: ['gift'],
  fete: ['party', 'tada'],
};

const RECENT_KEY = 'oriel:recentEmojis';

function pushRecent(emoji: string) {
  const list = storage.getJSON<string[]>(RECENT_KEY, []).filter((e) => e !== emoji);
  list.unshift(emoji);
  storage.setJSON(RECENT_KEY, list.slice(0, 24));
}

export function randomEmoji(data: EmojiMartData): string {
  const pool = ['people', 'nature', 'foods', 'activity', 'places', 'objects', 'symbols'];
  const cats = data.categories.filter((c) => pool.includes(c.id));
  const cat = cats[Math.floor(Math.random() * cats.length)] ?? data.categories[0]!;
  const id = cat.emojis[Math.floor(Math.random() * cat.emojis.length)]!;
  return data.emojis[id]?.skins[0]?.native ?? '📄';
}

export interface EmojiPickerPanelProps {
  onSelect: (emoji: string) => void;
  onRemove?: () => void;
}

export function EmojiPickerPanel({ onSelect, onRemove }: EmojiPickerPanelProps) {
  const [data, setData] = useState<EmojiMartData | null>(dataCache);
  const [query, setQuery] = useState('');
  const recents = useMemo(() => storage.getJSON<string[]>(RECENT_KEY, []), []);
  const [category, setCategory] = useState<string>(recents.length ? 'recent' : 'people');
  const inputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!data) void loadEmojiData().then(setData);
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [data]);

  const select = (emoji: string) => {
    pushRecent(emoji);
    onSelect(emoji);
  };

  // French keywords (CLDR via emojibase-data): loaded on the first search.
  const [frKeywords, setFrKeywords] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    if (!query || frKeywords) return;
    let live = true;
    void import('../data/emojiKeywordsFr').then((m) => live && setFrKeywords(m.default));
    return () => {
      live = false;
    };
  }, [query, frKeywords]);

  const results = useMemo(() => {
    if (!data) return [] as Array<{ id: string; native: string; name: string }>;
    const q = normalizeText(query);
    const toItem = (id: string) => {
      const e = data.emojis[id];
      return e ? { id, native: e.skins[0]!.native, name: e.name } : null;
    };
    if (q) {
      const words = q.split(/\s+/).filter(Boolean).map((w) => [w, ...(FRENCH_ALIASES[w] ?? [])]);
      const out: Array<{ id: string; native: string; name: string }> = [];
      for (const e of Object.values(data.emojis)) {
        const fr = frKeywords?.[e.skins[0]!.native.replace(/\uFE0F/g, '')] ?? '';
        const hay = [e.id, normalizeText(e.name), ...e.keywords, fr].join(' ');
        if (words.every((terms) => terms.some((t) => hay.includes(t)))) out.push({ id: e.id, native: e.skins[0]!.native, name: e.name });
        if (out.length >= 160) break;
      }
      return out;
    }
    if (category === 'recent') return recents.map((native) => ({ id: native, native, name: native }));
    const cat = data.categories.find((c) => c.id === category);
    return (cat?.emojis ?? []).map(toItem).filter((x): x is NonNullable<typeof x> => !!x);
  }, [data, query, category, recents, frKeywords]);

  const categories = ['recent', ...(data?.categories.map((c) => c.id) ?? [])].filter(
    (c) => CATEGORY_META[c] && (c !== 'recent' || recents.length > 0),
  );

  return (
    <div className="emoji-picker" onKeyDown={(e) => e.stopPropagation()}>
      <div className="emoji-picker__top">
        <label className="emoji-picker__search">
          <Search size={14} />
          <input
            ref={inputRef}
            value={query}
            placeholder="Rechercher un emoji…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && results[0]) select(results[0].native);
            }}
          />
        </label>
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          title="Aléatoire"
          aria-label="Emoji aléatoire"
          disabled={!data}
          onClick={() => data && select(randomEmoji(data))}
        >
          <Shuffle size={15} />
        </button>
        {onRemove && (
          <button type="button" className="btn btn--ghost btn--icon" title="Retirer" aria-label="Retirer l’icône" onClick={onRemove}>
            <Trash size={15} />
          </button>
        )}
      </div>
      {!query && (
        <div className="emoji-picker__tabs" role="tablist">
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              role="tab"
              aria-selected={c === category}
              title={CATEGORY_META[c]!.label}
              className={`emoji-picker__tab${c === category ? ' is-active' : ''}`}
              onClick={() => {
                setCategory(c);
                gridRef.current?.scrollTo({ top: 0 });
              }}
            >
              {CATEGORY_META[c]!.icon}
            </button>
          ))}
        </div>
      )}
      <div className="emoji-picker__label">
        {query ? (results.length ? 'Résultats' : 'Aucun emoji trouvé') : CATEGORY_META[category]?.label}
      </div>
      <div className="emoji-picker__grid" ref={gridRef}>
        {!data && <div className="emoji-picker__loading">Chargement…</div>}
        {results.map((r) => (
          <button key={r.id} type="button" className="emoji-picker__item" title={r.name} onClick={() => select(r.native)}>
            {r.native}
          </button>
        ))}
      </div>
    </div>
  );
}

export interface EmojiPickerPopoverProps extends EmojiPickerPanelProps {
  opened: boolean;
  onClose: () => void;
  children: ReactNode;
  position?: 'bottom-start' | 'bottom' | 'bottom-end' | 'right-start';
}

export function EmojiPickerPopover({ opened, onClose, children, position = 'bottom-start', onSelect, onRemove }: EmojiPickerPopoverProps) {
  return (
    <Popover opened={opened} onChange={(o) => !o && onClose()} position={position} shadow="md" withinPortal trapFocus={false}>
      <Popover.Target>{children}</Popover.Target>
      <Popover.Dropdown p={0} className="popover-panel">
        {opened && (
          <EmojiPickerPanel
            onSelect={(e) => {
              onSelect(e);
              onClose();
            }}
            onRemove={
              onRemove
                ? () => {
                    onRemove();
                    onClose();
                  }
                : undefined
            }
          />
        )}
      </Popover.Dropdown>
    </Popover>
  );
}
