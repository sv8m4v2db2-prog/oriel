// Form layout: a form whose questions are properties of the database. Each answer creates a row.
//  - editors: question editor (labels, descriptions, required, conditions, settings) + preview;
//  - members (viewers included): fill in → POST /api/forms/:vid/submit;
//  - form shared (`isPublic`) and open: anonymous answers through the share link (public page reading
//    GET /api/public/forms/:vid, then POST /api/public/forms/:vid/submit), simple question types only
//    (see logic/form.ts). The database does not need to be published (QA-VIEW-04).
// The `website` field is a honeypot: hidden from people, always sent (empty for humans).
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, CircleCheck, Copy, Eye, Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import type { DateValue, FileValue, FormConfig, FormQuestion, PlaceValue, PropertyDef, PropertyType, View } from '@oriel/shared';
import { PROPERTY_TYPE_LABELS } from '@oriel/shared';
import { dbExtrasApi } from '../api';
import { useDb } from '../context';
import { errorMessage } from '../data';
import {
  availableQuestionProperties,
  buildSubmission,
  conditionCandidates,
  conditionChoices,
  initialDraft,
  moveQuestion,
  newQuestionId,
  publicRestriction,
  removeQuestion,
  resolveQuestions,
  validateAnswers,
  visibleQuestions,
  type FormDraft,
  type FormMode,
  type ResolvedQuestion,
} from '../logic/form';
import { orderedOptions } from '../logic/values';
import { PropertyIcon } from '../ui/icons';
import { CheckBox, CommitInput, IconBtn, NativeSelect, Toggle, cx } from '../ui/primitives';
import { FilesEditor, PersonEditor, RelationEditor } from '../ui/editors/PickerEditors';
import { PlaceEditor } from '../ui/editors/PlaceEditor';
import type { ViewState } from '../view/types';

// ---------------------------------------------------------------------------
// Filling
// ---------------------------------------------------------------------------

/** Options of a select / status / multi-select question, in display order. */
const optionsOf = (prop: PropertyDef) => (prop.type === 'status' ? orderedOptions(prop) : (prop.options ?? []));

const INPUT_TYPES: Partial<Record<PropertyType, string>> = { url: 'url', email: 'email', phone: 'tel' };
const PLACEHOLDERS: Partial<Record<PropertyType, string>> = {
  url: 'https://…',
  email: 'nom@exemple.fr',
  phone: '06 12 34 56 78',
  number: 'Nombre',
};

/** Inputs of the types only asked to members (they need the workspace: people, pages, uploads, geocoding). */
function MemberAnswer({ q, value, onChange }: { q: ResolvedQuestion; value: unknown; onChange: (v: unknown) => void }) {
  const { workspaceId, publicMode } = useDb();
  const ids = Array.isArray(value) ? (value as string[]) : [];
  switch (q.prop.type) {
    case 'person':
      return <PersonEditor value={ids} onChange={onChange} />;
    case 'relation':
      return <RelationEditor prop={q.prop} value={ids} onChange={onChange} canCreate={false} />;
    case 'files':
      return <FilesEditor value={Array.isArray(value) ? (value as FileValue[]) : []} onChange={onChange} />;
    case 'place':
      return (
        <PlaceEditor
          value={(value as PlaceValue | null) ?? null}
          onChange={onChange}
          workspaceId={publicMode ? null : workspaceId || null}
          autoFocus={false}
        />
      );
    default:
      return null;
  }
}

function Answer({ q, value, onChange, disabled }: { q: ResolvedQuestion; value: unknown; onChange: (v: unknown) => void; disabled: boolean }) {
  const { prop, question } = q;
  const id = `ordb-q-${question.id}`;
  switch (prop.type) {
    case 'title':
    case 'number':
    case 'url':
    case 'email':
    case 'phone':
      return (
        <input
          id={id}
          className="ordb-input ordb-form-input"
          type={INPUT_TYPES[prop.type] ?? 'text'}
          inputMode={prop.type === 'number' ? 'decimal' : undefined}
          maxLength={prop.type === 'title' ? 2000 : 2000}
          placeholder={PLACEHOLDERS[prop.type] ?? 'Votre réponse'}
          value={typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'text':
      return (
        <textarea
          id={id}
          className="ordb-input ordb-form-input ordb-form-textarea"
          rows={3}
          maxLength={10_000}
          placeholder="Votre réponse"
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'select':
    case 'status': {
      const options = optionsOf(prop);
      if (options.length > 8) {
        return (
          <NativeSelect
            ariaLabel={q.label}
            value={typeof value === 'string' ? value : ''}
            onChange={(v) => onChange(v || undefined)}
            choices={[{ value: '', label: 'Choisir…' }, ...options.map((o) => ({ value: o.id, label: o.name }))]}
            disabled={disabled}
          />
        );
      }
      return (
        <div className="ordb-form-choices" role="radiogroup" aria-labelledby={`${id}-label`}>
          {options.map((o) => (
            <label key={o.id} className="ordb-form-choice">
              <input
                type="radio"
                name={id}
                checked={value === o.id}
                disabled={disabled}
                onChange={() => onChange(o.id)}
                onClick={() => value === o.id && !question.required && onChange(undefined)}
              />
              <span className="tag" data-color={o.color}>
                {o.name}
              </span>
            </label>
          ))}
          {options.length === 0 && <span className="ordb-muted">Aucune option.</span>}
        </div>
      );
    }
    case 'multi_select': {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="ordb-form-choices" role="group" aria-labelledby={`${id}-label`}>
          {optionsOf(prop).map((o) => (
            <label key={o.id} className="ordb-form-choice">
              <input
                type="checkbox"
                checked={selected.includes(o.id)}
                disabled={disabled}
                onChange={(e) => onChange(e.target.checked ? [...selected, o.id] : selected.filter((x) => x !== o.id))}
              />
              <span className="tag" data-color={o.color}>
                {o.name}
              </span>
            </label>
          ))}
          {optionsOf(prop).length === 0 && <span className="ordb-muted">Aucune option.</span>}
        </div>
      );
    }
    case 'checkbox':
      return (
        <label className="ordb-form-check">
          <CheckBox checked={value === true} onChange={(c) => onChange(c)} label={q.label} disabled={disabled} />
          <span>Oui</span>
        </label>
      );
    case 'date': {
      const d = value as DateValue | undefined;
      return (
        <input
          id={id}
          className="ordb-input ordb-form-input is-date"
          type="date"
          value={d?.start?.slice(0, 10) ?? ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value ? { start: e.target.value } : undefined)}
        />
      );
    }
    default:
      return (
        <div className={cx('ordb-form-rich', disabled && 'is-disabled')}>
          <MemberAnswer q={q} value={value} onChange={onChange} />
        </div>
      );
  }
}

export interface FormFillProps {
  view: Pick<View, 'id' | 'name'>;
  form: FormConfig;
  properties: PropertyDef[];
  mode: FormMode;
  /** Preview only: inputs work, nothing is sent. */
  preview?: boolean;
}

/** The form as people fill it in (members or anonymous visitors). */
export function FormFill({ view, form, properties, mode, preview = false }: FormFillProps) {
  const questions = useMemo(() => resolveQuestions(form, properties, mode), [form, properties, mode]);
  const [draft, setDraft] = useState<FormDraft>(() => initialDraft(questions));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [honeypot, setHoneypot] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [failure, setFailure] = useState<string | null>(null);
  const shown = visibleQuestions(questions, draft);
  const closed = !form.acceptResponses;
  const title = form.title?.trim() || view.name || 'Formulaire';

  // New questions (editor) start with their initial value.
  useEffect(() => {
    setDraft((d) => ({ ...initialDraft(questions), ...d }));
  }, [questions]);

  const set = (qid: string, v: unknown) => {
    setDraft((d) => ({ ...d, [qid]: v }));
    if (errors[qid]) setErrors(({ [qid]: _, ...rest }) => rest);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (closed || preview || state === 'sending') return;
    const errs = validateAnswers(questions, draft);
    setErrors(errs);
    setFailure(null);
    if (Object.keys(errs).length > 0) {
      document.getElementById(`ordb-q-${Object.keys(errs)[0]}`)?.focus();
      return;
    }
    setState('sending');
    try {
      const body = { answers: buildSubmission(questions, draft), website: honeypot };
      if (mode === 'public') await dbExtrasApi.submitPublicForm(view.id, body);
      else await dbExtrasApi.submitForm(view.id, body);
      setState('sent');
    } catch (err) {
      setFailure(errorMessage(err));
      setState('idle');
    }
  };

  const reset = () => {
    setDraft(initialDraft(questions));
    setErrors({});
    setState('idle');
  };

  if (state === 'sent') {
    return (
      <div className="ordb-form-card ordb-form-done" role="status">
        <CircleCheck size={28} className="ordb-form-done-icon" />
        <p className="ordb-form-done-text">{form.confirmation?.trim() || 'Merci, votre réponse a bien été envoyée.'}</p>
        <button type="button" className="ordb-btn is-outline is-sm" onClick={reset}>
          Envoyer une autre réponse
        </button>
      </div>
    );
  }

  return (
    <form className="ordb-form-card" onSubmit={(e) => void submit(e)} noValidate>
      <header className="ordb-form-head">
        <h2 className="ordb-form-title">{title}</h2>
        {form.description?.trim() && <p className="ordb-form-description">{form.description}</p>}
      </header>
      {closed && (
        <div className="ordb-form-closed" role="status">
          <Lock size={14} /> Ce formulaire n’accepte plus de réponses.
        </div>
      )}
      {!closed && questions.length === 0 && <div className="ordb-muted">Ce formulaire ne contient aucune question.</div>}
      {!closed &&
        shown.map((q) => (
          <div key={q.question.id} className={cx('ordb-form-question', errors[q.question.id] && 'has-error')}>
            <label className="ordb-form-label" id={`ordb-q-${q.question.id}-label`} htmlFor={`ordb-q-${q.question.id}`}>
              {q.label}
              {q.question.required && (
                <span className="ordb-form-required" aria-label="obligatoire">
                  {' '}
                  *
                </span>
              )}
            </label>
            {q.question.description?.trim() && <div className="ordb-form-help">{q.question.description}</div>}
            <Answer q={q} value={draft[q.question.id]} onChange={(v) => set(q.question.id, v)} disabled={state === 'sending'} />
            {errors[q.question.id] && (
              <div className="ordb-form-error" role="alert">
                {errors[q.question.id]}
              </div>
            )}
          </div>
        ))}
      {/* Honeypot: off-screen, skipped by keyboard and assistive technologies. */}
      {!closed && (
        <div className="ordb-form-trap" aria-hidden="true">
          <label>
            Site web
            <input type="text" name="website" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
          </label>
        </div>
      )}
      {failure && (
        <div className="ordb-form-error is-global" role="alert">
          {failure}
        </div>
      )}
      {!closed && (
        <div className="ordb-form-actions">
          <button type="submit" className="ordb-btn is-primary" disabled={preview || state === 'sending' || questions.length === 0}>
            {state === 'sending' ? 'Envoi…' : form.submitLabel?.trim() || 'Envoyer'}
          </button>
          {preview && <span className="ordb-muted">Aperçu : rien n’est envoyé.</span>}
        </div>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

function CommitTextarea({ value, onCommit, placeholder, ariaLabel }: { value: string; onCommit: (v: string) => void; placeholder: string; ariaLabel: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <textarea
      className="ordb-input ordb-form-input ordb-form-textarea"
      rows={2}
      maxLength={2000}
      value={draft}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
    />
  );
}

/** Types offered when a question creates its own property. */
const NEW_QUESTION_TYPES: PropertyType[] = ['text', 'number', 'select', 'multi_select', 'checkbox', 'date', 'email', 'phone', 'url'];

function QuestionEditor({
  q,
  index,
  count,
  all,
  form,
  onChange,
  onMove,
  onRemove,
}: {
  q: ResolvedQuestion;
  index: number;
  count: number;
  all: ResolvedQuestion[];
  form: FormConfig;
  onChange: (patch: Partial<FormQuestion>) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const { question, prop } = q;
  const candidates = conditionCandidates(question, all);
  const condQ = candidates.find((c) => c.question.id === question.showIf?.questionId);
  const restriction = form.isPublic ? publicRestriction(prop) : null;
  return (
    <div className="ordb-form-edit-q">
      <div className="ordb-form-edit-q-head">
        <span className="ordb-form-edit-prop" title={`Propriété : ${prop.name}`}>
          <PropertyIcon type={prop.type} size={14} /> {prop.name}
          <span className="ordb-muted"> · {PROPERTY_TYPE_LABELS[prop.type]}</span>
        </span>
        <span className="ordb-form-edit-tools">
          <IconBtn label="Monter" disabled={index === 0} onClick={() => onMove(-1)}>
            <ArrowUp size={14} />
          </IconBtn>
          <IconBtn label="Descendre" disabled={index === count - 1} onClick={() => onMove(1)}>
            <ArrowDown size={14} />
          </IconBtn>
          <IconBtn label="Retirer la question" onClick={onRemove}>
            <Trash2 size={14} />
          </IconBtn>
        </span>
      </div>
      <CommitInput
        className="ordb-input ordb-form-input"
        value={question.label ?? ''}
        placeholder={prop.name}
        ariaLabel="Libellé de la question"
        onCommit={(v) => onChange({ label: v.trim() ? v.trim().slice(0, 300) : undefined })}
      />
      <CommitTextarea
        value={question.description ?? ''}
        placeholder="Aide (facultatif)"
        ariaLabel="Description de la question"
        onCommit={(v) => onChange({ description: v.trim() ? v.slice(0, 2000) : undefined })}
      />
      <div className="ordb-form-edit-row">
        <Toggle checked={!!question.required} onChange={(c) => onChange({ required: c })} label="Obligatoire" />
      </div>
      {candidates.length > 0 && (
        <div className="ordb-form-edit-row is-condition">
          <span className="ordb-muted">Afficher seulement si</span>
          <NativeSelect
            ariaLabel="Question de la condition"
            value={condQ?.question.id ?? ''}
            onChange={(qid) => {
              const c = candidates.find((x) => x.question.id === qid);
              const first = c ? conditionChoices(c.prop)[0] : undefined;
              onChange({ showIf: c && first ? { questionId: c.question.id, value: first.value } : null });
            }}
            choices={[{ value: '', label: 'Toujours' }, ...candidates.map((c) => ({ value: c.question.id, label: c.label }))]}
          />
          {condQ && (
            <>
              <span className="ordb-muted">{condQ.prop.type === 'multi_select' ? 'contient' : 'vaut'}</span>
              <NativeSelect
                ariaLabel="Valeur de la condition"
                value={question.showIf?.value ?? ''}
                onChange={(value) => onChange({ showIf: { questionId: condQ.question.id, value } })}
                choices={conditionChoices(condQ.prop)}
              />
            </>
          )}
        </div>
      )}
      {question.showIf && !condQ && <div className="ordb-form-warning">La condition de cette question n’est plus valable : elle ne sera pas posée.</div>}
      {restriction && <div className="ordb-form-warning">{restriction}</div>}
    </div>
  );
}

/** Public link of a form (views of linked blocks included: the public page reads the form by its view id). */
function shareUrl(databaseId: string, viewId: string) {
  return `${window.location.origin}/share/${encodeURIComponent(databaseId)}/form/${encodeURIComponent(viewId)}`;
}

function FormEditor({ vs, form }: { vs: ViewState; form: FormConfig }) {
  const { properties, m, databaseId, page } = useDb();
  const [copied, setCopied] = useState(false);
  const all = useMemo(() => resolveQuestions(form, properties, 'member'), [form, properties]);
  const available = availableQuestionProperties(form, properties);
  // Every change starts from the latest saved form: a field committed on blur and the click that
  // blurred it (« Retirer la question »…) are two saves before the next render.
  const latest = useRef(form);
  const received = useRef(form);
  if (received.current !== form) {
    received.current = form;
    latest.current = form;
  }
  const save = (change: (f: FormConfig) => FormConfig) => {
    const next = change(latest.current);
    latest.current = next;
    vs.setConfig({ form: next });
  };
  const patchQuestion = (id: string, patch: Partial<FormQuestion>) =>
    save((f) => ({ ...f, questions: f.questions.map((q) => (q.id === id ? { ...q, ...patch } : q)) }));
  const move = (id: string, delta: -1 | 1) => save((f) => moveQuestion(f, id, delta));
  const addQuestion = (propertyId: string) =>
    save((f) => ({ ...f, questions: [...f.questions, { id: newQuestionId(f), propertyId, required: false }] }));
  const addNewProperty = (type: PropertyType) => {
    const name = `Question ${form.questions.length + 1}`;
    const { id } = m.createProperty({ name, type, ...(type === 'select' || type === 'multi_select' ? { options: [] } : {}) });
    addQuestion(id);
  };

  return (
    <div className="ordb-form-editor">
      <section className="ordb-form-card">
        <CommitInput
          className="ordb-input ordb-form-title-input"
          value={form.title ?? ''}
          placeholder={vs.view.name || 'Titre du formulaire'}
          ariaLabel="Titre du formulaire"
          onCommit={(v) => save((f) => ({ ...f, title: v.trim() ? v.trim().slice(0, 300) : undefined }))}
        />
        <CommitTextarea
          value={form.description ?? ''}
          placeholder="Description (facultatif)"
          ariaLabel="Description du formulaire"
          onCommit={(v) => save((f) => ({ ...f, description: v.trim() ? v.slice(0, 2000) : undefined }))}
        />
      </section>

      {all.map((q, i) => (
        <section key={q.question.id} className="ordb-form-card is-question">
          <QuestionEditor
            q={q}
            index={i}
            count={all.length}
            all={all}
            form={form}
            onChange={(patch) => patchQuestion(q.question.id, patch)}
            onMove={(d) => move(q.question.id, d)}
            onRemove={() => save((f) => removeQuestion(f, q.question.id))}
          />
        </section>
      ))}

      <section className="ordb-form-card is-add">
        <div className="ordb-form-edit-row">
          <Plus size={14} className="ordb-muted" />
          <NativeSelect
            ariaLabel="Ajouter une question à partir d’une propriété"
            value=""
            onChange={(v) => v && addQuestion(v)}
            choices={[
              { value: '', label: available.length ? 'Ajouter une propriété existante…' : 'Toutes les propriétés sont déjà posées' },
              ...available.map((p) => ({ value: p.id, label: `${p.name} (${PROPERTY_TYPE_LABELS[p.type]})` })),
            ]}
            disabled={available.length === 0}
          />
          <NativeSelect
            ariaLabel="Ajouter une question avec une nouvelle propriété"
            value=""
            onChange={(v) => v && addNewProperty(v as PropertyType)}
            choices={[
              { value: '', label: 'Nouvelle propriété…' },
              ...NEW_QUESTION_TYPES.map((t) => ({ value: t, label: PROPERTY_TYPE_LABELS[t] })),
            ]}
          />
        </div>
        <p className="ordb-form-help">Chaque question remplit une propriété de la base ; chaque réponse crée une ligne.</p>
      </section>

      <section className="ordb-form-card is-settings">
        <h3 className="ordb-form-section-title">Réglages</h3>
        <label className="ordb-form-field">
          <span>Texte du bouton</span>
          <CommitInput
            className="ordb-input ordb-form-input"
            value={form.submitLabel ?? ''}
            placeholder="Envoyer"
            ariaLabel="Texte du bouton d’envoi"
            onCommit={(v) => save((f) => ({ ...f, submitLabel: v.trim() ? v.trim().slice(0, 60) : undefined }))}
          />
        </label>
        <label className="ordb-form-field">
          <span>Message après envoi</span>
          <CommitTextarea
            value={form.confirmation ?? ''}
            placeholder="Merci, votre réponse a bien été envoyée."
            ariaLabel="Message de confirmation"
            onCommit={(v) => save((f) => ({ ...f, confirmation: v.trim() ? v.slice(0, 1000) : undefined }))}
          />
        </label>
        <Toggle checked={form.acceptResponses} onChange={(c) => save((f) => ({ ...f, acceptResponses: c }))} label="Accepter les réponses" />
        <Toggle checked={!!form.isPublic} onChange={(c) => save((f) => ({ ...f, isPublic: c }))} label="Ouvert aux personnes sans compte" />
        {form.isPublic && (
          <div className="ordb-form-public">
            <p className="ordb-form-help">
              Le formulaire se remplit via ce lien de partage d’Oriel, sans compte et sans publier la base : le lien ne montre
              que les questions, jamais les réponses. Les questions de type personne, relation, fichier ou lieu ne sont posées
              qu’aux membres.
              {page?.isPublic
                ? ' Attention : cette base est publiée, ses lignes (donc les réponses) sont lisibles par toute personne qui a le lien de la base.'
                : ' Ne publiez pas la base, ni une page qui la contient, si les réponses doivent rester privées.'}
            </p>
            <div className="ordb-form-edit-row">
              <input className="ordb-input ordb-form-input" readOnly value={shareUrl(databaseId, vs.view.id)} aria-label="Lien du formulaire" onFocus={(e) => e.target.select()} />
              <button
                type="button"
                className="ordb-btn is-outline is-sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(shareUrl(databaseId, vs.view.id)).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                <Copy size={13} /> {copied ? 'Copié' : 'Copier'}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function Segmented<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: Array<{ value: T; label: ReactNode }> }) {
  return (
    <div className="ordb-segmented" role="tablist">
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          role="tab"
          aria-selected={value === it.value}
          className={cx('ordb-segmented-item', value === it.value && 'is-active')}
          onClick={() => onChange(it.value)}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

const EMPTY_FORM: FormConfig = { questions: [], acceptResponses: true, isPublic: false };

export function FormView({ vs }: { vs: ViewState }) {
  const { properties, canEdit, publicMode } = useDb();
  const form = vs.config.form ?? EMPTY_FORM;
  const [tab, setTab] = useState<'edit' | 'fill'>(canEdit ? 'edit' : 'fill');
  const [asVisitor, setAsVisitor] = useState(false);

  if (publicMode) {
    if (!form.isPublic) {
      return (
        <div className="ordb-form">
          <div className="ordb-form-card ordb-form-closed">
            <Lock size={14} /> Ce formulaire est réservé aux membres de l’espace de travail.
          </div>
        </div>
      );
    }
    return (
      <div className="ordb-form">
        <FormFill key={vs.view.id} view={vs.view} form={form} properties={properties} mode="public" />
      </div>
    );
  }

  return (
    <div className="ordb-form">
      {canEdit && (
        <div className="ordb-form-bar">
          <Segmented
            value={tab}
            onChange={setTab}
            items={[
              { value: 'edit', label: <><Pencil size={13} /> Questions</> },
              { value: 'fill', label: <><Eye size={13} /> Aperçu et réponse</> },
            ]}
          />
          {tab === 'fill' && form.isPublic && <Toggle checked={asVisitor} onChange={setAsVisitor} label="Comme une personne sans compte" />}
        </div>
      )}
      {canEdit && tab === 'edit' ? (
        <FormEditor vs={vs} form={form} />
      ) : (
        <FormFill
          key={`${vs.view.id}:${asVisitor && canEdit ? 'public' : 'member'}`}
          view={vs.view}
          form={form}
          properties={properties}
          mode={asVisitor && canEdit && form.isPublic ? 'public' : 'member'}
          preview={asVisitor && canEdit && form.isPublic}
        />
      )}
    </div>
  );
}
