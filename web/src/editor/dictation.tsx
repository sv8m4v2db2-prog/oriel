// Voice dictation (E24): the browser's SpeechRecognition API inserts the recognized text at the cursor.
// Hidden when the API does not exist. The audio is processed by the browser vendor's service: the user
// accepts a notice once (remembered in this browser) and starts every dictation with a click.
import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, X } from 'lucide-react';
import { storage } from '../lib/store';
import type { OrielEditor } from './schema';

interface RecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}
interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<RecognitionResultLike> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionCtor = new () => RecognitionLike;

const NOTICE_KEY = 'oriel:dictation-notice';
const LANG_KEY = 'oriel:dictation-lang';
export const DICTATION_LANGUAGES: Array<[string, string]> = [
  ['fr-FR', 'Français'],
  ['en-US', 'English'],
  ['es-ES', 'Español'],
  ['de-DE', 'Deutsch'],
  ['it-IT', 'Italiano'],
  ['ar-SA', 'العربية'],
  ['he-IL', 'עברית'],
];

export function speechRecognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const ERRORS: Record<string, string> = {
  'not-allowed': 'Le micro est refusé : autorisez-le dans les réglages du navigateur.',
  'service-not-allowed': 'Le service de reconnaissance vocale est refusé par le navigateur.',
  network: 'Le service de reconnaissance vocale est injoignable (ou indisponible dans cette application).',
  'no-speech': 'Aucune voix détectée.',
  'audio-capture': 'Aucun micro détecté.',
};

export function DictationButton({ editor }: { editor: OrielEditor }) {
  const Ctor = useRef(speechRecognitionCtor()).current;
  const [active, setActive] = useState(false);
  const [interim, setInterim] = useState('');
  const [message, setMessage] = useState('');
  const [needsNotice, setNeedsNotice] = useState(false);
  // The controls only appear once dictation is requested (slash menu), never as a permanent overlay.
  const [open, setOpen] = useState(false);
  const [lang, setLang] = useState(() => {
    const saved = storage.get(LANG_KEY);
    return DICTATION_LANGUAGES.some(([c]) => c === saved) ? (saved as string) : 'fr-FR';
  });
  const recRef = useRef<RecognitionLike | null>(null);

  useEffect(() => () => recRef.current?.stop(), []);
  // Slash menu item "Dictée vocale".
  const startRef = useRef<() => void>(() => {});
  useEffect(() => {
    const on = () => startRef.current();
    window.addEventListener('oriel:dictation-start', on);
    return () => window.removeEventListener('oriel:dictation-start', on);
  }, []);
  if (!Ctor) return null;

  const stop = () => recRef.current?.stop();
  const start = () => {
    if (storage.get(NOTICE_KEY) !== 'ok') {
      setNeedsNotice(true);
      return;
    }
    setMessage('');
    const rec = new Ctor();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let partial = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!;
        const text = r[0].transcript;
        if (r.isFinal) {
          try {
            editor.insertInlineContent(text.trimEnd() + ' ');
          } catch {
            /* no text cursor */
          }
        } else partial += text;
      }
      setInterim(partial);
    };
    rec.onerror = (e) => setMessage(ERRORS[e.error] ?? 'La dictée s’est arrêtée.');
    rec.onend = () => {
      setActive(false);
      setInterim('');
      recRef.current = null;
    };
    recRef.current = rec;
    try {
      rec.start();
      setActive(true);
    } catch {
      setMessage('La dictée n’a pas pu démarrer.');
    }
  };

  startRef.current = () => {
    setOpen(true);
    if (!recRef.current) start();
  };

  if (!open && !active && !needsNotice) return null;

  return (
    <div className="or-dictation" onKeyDown={(e) => e.key === 'Escape' && stop()}>
      {(interim || message) && (
        <div className="or-dictation__bubble" role="status">
          {message || interim}
        </div>
      )}
      {needsNotice && (
        <div className="or-dictation__notice" role="dialog" aria-label="Dictée vocale">
          <p>
            La dictée envoie votre voix au service de reconnaissance de votre navigateur (par exemple Google pour Chrome) : l’audio peut être
            traité par ce fournisseur. Oriel ne l’enregistre pas.
          </p>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => {
              storage.set(NOTICE_KEY, 'ok');
              setNeedsNotice(false);
              start();
            }}
          >
            J’ai compris, dicter
          </button>{' '}
          <button type="button" className="btn btn--sm" onClick={() => setNeedsNotice(false)}>
            Annuler
          </button>
        </div>
      )}
      <select
        className="or-dictation__lang"
        aria-label="Langue de la dictée"
        value={lang}
        disabled={active}
        onChange={(e) => {
          setLang(e.target.value);
          storage.set(LANG_KEY, e.target.value);
        }}
      >
        {DICTATION_LANGUAGES.map(([code, name]) => (
          <option key={code} value={code}>
            {name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className={`or-dictation__btn${active ? ' or-dictation__btn--on' : ''}`}
        title={active ? 'Arrêter la dictée' : 'Dicter du texte'}
        aria-pressed={active}
        onMouseDown={(e) => e.preventDefault()}
        onClick={active ? stop : start}
      >
        {active ? <MicOff size={16} /> : <Mic size={16} />}
      </button>
      {!active && (
        <button
          type="button"
          className="or-dictation__btn"
          title="Fermer la dictée"
          aria-label="Fermer la dictée"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setOpen(false);
            setNeedsNotice(false);
            setMessage('');
          }}
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
}
