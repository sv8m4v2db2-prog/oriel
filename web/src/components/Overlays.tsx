// Global overlay hosts: toasts, confirmation and prompt dialogs.
import { useEffect, useRef, useState } from 'react';
import { Modal } from '@mantine/core';
import { CircleAlert, Check, Info, X } from 'lucide-react';
import { useStore } from '../lib/store';
import { confirmStore, dismissToast, promptStore, toastStore } from '../lib/ui';

export function Toaster() {
  const toasts = useStore(toastStore);
  return (
    <div className="toaster" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.tone}`}>
          <span className="toast__icon">
            {t.tone === 'success' ? <Check size={15} /> : t.tone === 'error' ? <CircleAlert size={15} /> : <Info size={15} />}
          </span>
          <span className="toast__message">{t.message}</span>
          {t.action && (
            <button
              type="button"
              className="toast__action"
              onClick={() => {
                t.action!.onClick();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" className="toast__close" aria-label="Fermer" onClick={() => dismissToast(t.id)}>
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function ConfirmHost() {
  const req = useStore(confirmStore);
  const close = (ok: boolean) => {
    req?.resolve(ok);
    confirmStore.set(null);
  };
  return (
    <Modal opened={!!req} onClose={() => close(false)} title={req?.title} centered size="sm" radius="md">
      {req?.message && <p className="dialog-text">{req.message}</p>}
      <div className="dialog-actions">
        <button type="button" className="btn btn--secondary" onClick={() => close(false)}>
          {req?.cancelLabel ?? 'Annuler'}
        </button>
        <button
          type="button"
          className={`btn ${req?.danger ? 'btn--danger' : 'btn--primary'}`}
          data-autofocus
          onClick={() => close(true)}
        >
          {req?.confirmLabel ?? 'Confirmer'}
        </button>
      </div>
    </Modal>
  );
}

export function PromptHost() {
  const req = useStore(promptStore);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (req) setValue(req.initialValue ?? '');
  }, [req]);
  const close = (v: string | null) => {
    req?.resolve(v);
    promptStore.set(null);
  };
  return (
    <Modal opened={!!req} onClose={() => close(null)} title={req?.title} centered size="sm" radius="md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) close(value.trim());
        }}
      >
        {req?.label && <label className="field-label">{req.label}</label>}
        <input
          ref={inputRef}
          className="input"
          data-autofocus
          value={value}
          placeholder={req?.placeholder}
          onChange={(e) => setValue(e.target.value)}
        />
        <div className="dialog-actions">
          <button type="button" className="btn btn--secondary" onClick={() => close(null)}>
            Annuler
          </button>
          <button type="submit" className="btn btn--primary" disabled={!value.trim()}>
            {req?.confirmLabel ?? 'Valider'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
