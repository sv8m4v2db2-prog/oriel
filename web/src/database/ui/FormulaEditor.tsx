// Formula editor (modal): expression, live syntax check, preview on a sample row, help lists.
import { useMemo, useRef, useState } from 'react';
import { Modal } from '@mantine/core';
import { CircleAlert, CircleCheck } from 'lucide-react';
import type { Page, PropertyDef } from '@oriel/shared';
import { PROPERTY_TYPE_LABELS } from '@oriel/shared';
import { useDb } from '../context';
import { formatFormulaResult } from '../logic/format';
import { compileFormula, evaluateFormula, FORMULA_FUNCTIONS } from '../logic/formula';
import { formulaCompletions } from '../logic/formulaCompletion';
import { createRowContext, evaluationKey, formulaEnv } from '../logic/values';
import { PropertyIcon } from './icons';
import { Btn } from './primitives';

/** Help groups of the function list, in display order (I2: lists, pages, people and variables). */
const FUNCTION_GROUPS: ReadonlyArray<{ category: (typeof FORMULA_FUNCTIONS)[number]['category']; label: string }> = [
  { category: 'listes', label: 'Listes, pages et personnes' },
  { category: 'variables', label: 'Variables locales' },
  { category: 'logique', label: 'Logique' },
  { category: 'texte', label: 'Texte' },
  { category: 'nombres', label: 'Nombres' },
  { category: 'dates', label: 'Dates' },
];

/** Text inserted by a click in the function list: suffix form for list functions (liste.map(…)). */
const insertionOf = (f: (typeof FORMULA_FUNCTIONS)[number]) => (f.signature.startsWith(`${f.name}(`) ? `${f.name}(` : `.${f.name}(`);

export function FormulaEditor({
  opened,
  prop,
  sampleRow,
  onClose,
}: {
  opened: boolean;
  prop: PropertyDef;
  sampleRow?: Page;
  onClose: () => void;
}) {
  return (
    <Modal opened={opened} onClose={onClose} title={`Formule — ${prop.name}`} size="lg" centered zIndex={400}>
      {opened && <FormulaEditorBody prop={prop} sampleRow={sampleRow} onClose={onClose} />}
    </Modal>
  );
}

function FormulaEditorBody({ prop, sampleRow, onClose }: { prop: PropertyDef; sampleRow?: Page; onClose: () => void }) {
  const { properties, m, ctx, canEdit } = useDb();
  const [source, setSource] = useState(prop.formula ?? '');
  const area = useRef<HTMLTextAreaElement>(null);
  const compiled = useMemo(() => compileFormula(source), [source]);
  // Autocompletion: identifier at the caret; Escape hides it until the caret moves.
  const [caret, setCaret] = useState(source.length);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const suggestions = useMemo(() => (dismissedAt === caret ? null : formulaCompletions(source, caret)), [source, caret, dismissedAt]);
  const active = suggestions ? Math.min(activeSuggestion, suggestions.items.length - 1) : 0;

  const unknownRefs = compiled.references.filter((name) => !properties.some((p) => p.name === name));
  const selfRef = compiled.references.includes(prop.name);

  const preview = useMemo(() => {
    if (!sampleRow || compiled.error || !compiled.ast) return null;
    // Evaluate the draft against the sample row (other formulas keep their saved expression).
    const draftCtx = createRowContext(
      properties.map((p) => (p.id === prop.id ? { ...p, formula: source } : p)),
      { users: ctx.users.values(), relationTitle: ctx.relationTitle, now: ctx.now, related: ctx.related },
    );
    const draftProp = draftCtx.byId.get(prop.id) ?? prop;
    const env = formulaEnv(sampleRow, draftCtx, [evaluationKey(sampleRow, draftProp)]);
    return evaluateFormula(compiled, {
      ...env,
      getProp: (name) => (draftCtx.byName.get(name)?.id === prop.id ? undefined : env.getProp(name)),
    });
  }, [sampleRow, compiled, properties, prop.id, source, ctx]);

  const insert = (text: string) => {
    const el = area.current;
    if (!el) {
      setSource((s) => s + text);
      return;
    }
    const start = el.selectionStart ?? source.length;
    const end = el.selectionEnd ?? source.length;
    const next = source.slice(0, start) + text + source.slice(end);
    setSource(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + text.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const acceptSuggestion = (index: number) => {
    const item = suggestions?.items[index];
    if (!suggestions || !item) return;
    const next = source.slice(0, suggestions.start) + item.insert + source.slice(caret);
    const pos = suggestions.start + item.insert.length;
    setSource(next);
    setCaret(pos);
    setActiveSuggestion(0);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(pos, pos);
    });
  };

  const trackCaret = (el: HTMLTextAreaElement) => {
    const pos = el.selectionStart ?? el.value.length;
    if (pos !== caret) {
      setCaret(pos);
      setActiveSuggestion(0);
    }
  };

  const save = () => {
    if (!canEdit) return;
    void m.updateProperty(prop.id, { formula: source });
    onClose();
  };

  const error = compiled.error
    ? `${compiled.error.message} (position ${compiled.error.position + 1})`
    : unknownRefs.length
      ? `Propriété introuvable : ${unknownRefs.map((n) => `« ${n} »`).join(', ')} (supprimée, renommée ou masquée pour vous)`
      : selfRef
        ? 'Une formule ne peut pas se référencer elle-même.'
        : preview?.error ?? null;

  return (
    <div className="ordb-formula">
      <textarea
        ref={area}
        className="ordb-formula-input"
        value={source}
        spellCheck={false}
        aria-label="Expression de la formule"
        placeholder='Exemple : prop("Prix") * prop("Quantité")'
        readOnly={!canEdit}
        data-autofocus
        autoFocus
        onChange={(e) => {
          setSource(e.target.value);
          trackCaret(e.target);
        }}
        onSelect={(e) => trackCaret(e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
            return;
          }
          if (!suggestions) return;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const n = suggestions.items.length;
            setActiveSuggestion((active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            acceptSuggestion(active);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setDismissedAt(caret);
          }
        }}
        aria-autocomplete="list"
        aria-controls={suggestions ? 'ordb-formula-suggest' : undefined}
        aria-activedescendant={suggestions ? `ordb-formula-suggest-${active}` : undefined}
      />
      {suggestions && canEdit && (
        <div className="ordb-formula-suggest" id="ordb-formula-suggest" role="listbox" aria-label="Suggestions">
          {suggestions.items.map((item, i) => (
            <button
              type="button"
              key={item.label}
              id={`ordb-formula-suggest-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'ordb-formula-suggest-item is-active' : 'ordb-formula-suggest-item'}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => acceptSuggestion(i)}
            >
              <code>{item.kind === 'function' ? `${item.label}()` : item.label}</code>
              <span className="ordb-muted">{item.detail}</span>
            </button>
          ))}
        </div>
      )}
      <div className={error ? 'ordb-formula-status is-error' : 'ordb-formula-status'} role="status">
        {error ? (
          <>
            <CircleAlert size={14} /> {error}
          </>
        ) : source.trim() ? (
          <>
            <CircleCheck size={14} /> Formule valide
            {preview && sampleRow && (
              <span className="ordb-muted">
                {' '}
                — résultat pour « {sampleRow.title || 'Sans titre'} » : <strong>{formatFormulaResult(preview) || 'vide'}</strong>
              </span>
            )}
          </>
        ) : (
          <span className="ordb-muted">Saisissez une expression.</span>
        )}
      </div>
      <div className="ordb-formula-help">
        <div>
          <div className="ordb-menu-label">Propriétés</div>
          <div className="ordb-formula-list">
            {properties
              .filter((p) => p.id !== prop.id)
              .map((p) => (
                <button
                  type="button"
                  key={p.id}
                  className="ordb-formula-item"
                  onClick={() => insert(`prop("${p.name.replace(/"/g, '\\"')}")`)}
                  title={PROPERTY_TYPE_LABELS[p.type]}
                >
                  <PropertyIcon type={p.type} />
                  <span>{p.name}</span>
                </button>
              ))}
          </div>
        </div>
        <div>
          <div className="ordb-menu-label">Fonctions</div>
          <div className="ordb-formula-list">
            {FUNCTION_GROUPS.map((group) => (
              <div key={group.category} className="ordb-formula-group">
                <div className="ordb-formula-group-label">{group.label}</div>
                {FORMULA_FUNCTIONS.filter((f) => f.category === group.category).map((f) => (
                  <button
                    type="button"
                    key={f.name}
                    className="ordb-formula-item is-fn"
                    onClick={() => insert(insertionOf(f))}
                    title={f.description}
                  >
                    <code>{f.signature}</code>
                    <span className="ordb-muted">{f.description}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div className="ordb-menu-hint">
            Opérateurs : + − * / % · == != &gt; &lt; &gt;= &lt;= · and, or, not · chaînes entre guillemets · [a, b] : une liste.
          </div>
          <div className="ordb-menu-hint">
            Une relation ou une personne donne une liste : prop("Tâches").filter(current.prop("Statut") == "Fait").length().
            Dans map(), filter()…, current désigne l’élément et index sa position ; page.prop("Nom") lit une propriété de la
            page liée. let(nom, valeur, expression) nomme un calcul intermédiaire.
          </div>
        </div>
      </div>
      <div className="ordb-confirm-actions">
        <Btn variant="outline" onClick={onClose}>
          Annuler
        </Btn>
        {canEdit && (
          <Btn variant="primary" onClick={save}>
            Enregistrer
          </Btn>
        )}
      </div>
    </div>
  );
}
