// Editor of `place` values: address search through the instance's geocoding proxy
// (GET /api/workspaces/:wid/geocode, off unless the administrator set GEOCODER_URL), or a free
// address — optionally with coordinates typed by hand — when no geocoder is configured.
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader, MapPin, Trash, Type } from 'lucide-react';
import type { PlaceValue } from '@oriel/shared';
import { dbExtrasApi } from '../../api';
import { errorMessage } from '../../data';
import { formatCoordinates, parseCoordinates, typedPlaceChoices } from '../../logic/map';
import { cx, MenuDivider } from '../primitives';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function PlaceEditor({
  value,
  onChange,
  onDone,
  workspaceId,
  searchable = true,
  autoFocus = true,
}: {
  value: PlaceValue | null;
  onChange: (v: PlaceValue | null) => void;
  onDone?: () => void;
  /** Workspace whose geocoding proxy is used (none: free address only). */
  workspaceId: string | null;
  searchable?: boolean;
  /** Focus the address field on mount (cell popovers; not in a form). */
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState(value?.address ?? '');
  const [highlight, setHighlight] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const q = useDebounced(query.trim(), 450);
  const canSearch = searchable && !!workspaceId && q.length >= 3 && q !== (value?.address ?? '').trim() && !parseCoordinates(q);
  const search = useQuery({
    queryKey: ['geocode', workspaceId, q.normalize('NFC').toLocaleLowerCase('fr')],
    queryFn: () => dbExtrasApi.geocode(workspaceId!, q),
    enabled: canSearch,
    staleTime: 10 * 60_000,
    retry: false,
  });
  const disabled = search.data?.enabled === false;
  const results = canSearch ? (search.data?.results ?? []) : [];
  const typed = query.trim();
  const typedChoices = typedPlaceChoices(typed, value);

  useEffect(() => setHighlight(0), [results.length]);

  const choose = (v: PlaceValue | null) => {
    onChange(v);
    onDone?.();
  };
  const options: Array<{ key: string; pick: () => void }> = [
    ...results.map((r, i) => ({ key: `r${i}`, pick: () => choose({ address: r.address, lat: r.lat, lng: r.lng }) })),
    ...typedChoices.map((c, i) => ({ key: `t${i}`, pick: () => choose(c.value) })),
  ];

  return (
    <div className="ordb-picker ordb-place-editor">
      <div className="ordb-panel-body">
        <input
          ref={input}
          className="ordb-input"
          value={query}
          autoFocus={autoFocus}
          maxLength={500}
          placeholder={searchable && workspaceId ? 'Rechercher une adresse…' : 'Adresse…'}
          aria-label="Adresse"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && options.length) {
              e.preventDefault();
              setHighlight((h) => (h + 1) % options.length);
            } else if (e.key === 'ArrowUp' && options.length) {
              e.preventDefault();
              setHighlight((h) => (h - 1 + options.length) % options.length);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (options[highlight]) options[highlight]!.pick();
              else if (!typed) choose(null);
            }
          }}
        />
      </div>
      {value && typeof value.lat === 'number' && typeof value.lng === 'number' && (
        <div className="ordb-menu-hint is-tight">
          <MapPin size={12} /> {formatCoordinates(value.lat, value.lng)}
        </div>
      )}
      <div className="ordb-options-list" role="listbox">
        {canSearch && search.isFetching && (
          <div className="ordb-menu-empty">
            <Loader size={13} className="ordb-spin" /> Recherche…
          </div>
        )}
        {canSearch && search.isError && <div className="ordb-menu-empty">{errorMessage(search.error)}</div>}
        {results.map((r, i) => (
          <button
            type="button"
            key={`${r.lat},${r.lng},${i}`}
            role="option"
            aria-selected={highlight === i}
            className={cx('ordb-option-row', highlight === i && 'is-highlighted')}
            onMouseEnter={() => setHighlight(i)}
            onClick={() => options[i]!.pick()}
          >
            <MapPin size={14} className="ordb-muted" />
            <span className="ordb-place-result">{r.address}</span>
          </button>
        ))}
        {canSearch && !search.isFetching && search.isSuccess && !disabled && results.length === 0 && (
          <div className="ordb-menu-empty">Aucune adresse trouvée</div>
        )}
        {typedChoices.map((c, i) => {
          const index = results.length + i;
          return (
            <button
              type="button"
              key={`t${i}`}
              role="option"
              aria-selected={highlight === index}
              className={cx('ordb-option-row', highlight === index && 'is-highlighted')}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => options[index]!.pick()}
            >
              {c.located ? <MapPin size={14} className="ordb-muted" /> : <Type size={14} className="ordb-muted" />}
              <span className="ordb-place-result">
                {c.label}
                {!c.located && <span className="ordb-muted"> (sans position sur la carte)</span>}
              </span>
            </button>
          );
        })}
      </div>
      {(disabled || !workspaceId || !searchable) && (
        <div className="ordb-menu-hint">
          La recherche d’adresse n’est pas activée sur cette instance : l’adresse est enregistrée telle quelle. Pour la placer sur
          une carte, saisissez ses coordonnées (ex. « 48,8566 ; 2,3522 »).
        </div>
      )}
      {value && (
        <>
          <MenuDivider />
          <button type="button" className="ordb-option-row" onClick={() => choose(null)}>
            <Trash size={14} className="ordb-muted" />
            <span>Effacer le lieu</span>
          </button>
        </>
      )}
    </div>
  );
}
