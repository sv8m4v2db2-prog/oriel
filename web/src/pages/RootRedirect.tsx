import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { errorMessage, queryClient } from '../lib/queryClient';
import { qk } from '../lib/queryKeys';
import { pickWorkspace, rememberWorkspace, useSession } from '../lib/session';
import { logoutWithConfirm } from '../lib/logout';
import { ErrorState, Spinner } from '../components/common';
import { AuthLayout } from '../auth/AuthPages';

export function RootRedirect() {
  const session = useSession();
  if (session.isLoading) {
    return (
      <div className="center-screen">
        <Spinner size={22} />
      </div>
    );
  }
  if (session.isError) {
    return (
      <div className="center-screen">
        <ErrorState title="Serveur injoignable" message={errorMessage(session.error)} onRetry={() => void session.refetch()} />
      </div>
    );
  }
  if (!session.data) return <Navigate to="/login" replace />;
  const ws = pickWorkspace(session.data.workspaces);
  if (ws) return <Navigate to={`/w/${ws.id}`} replace />;
  return <CreateFirstWorkspace />;
}

function CreateFirstWorkspace() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const ws = await api.workspaces.create({ name: name.trim(), icon: '🧊' });
      rememberWorkspace(ws.id);
      await queryClient.invalidateQueries({ queryKey: qk.session });
      await queryClient.invalidateQueries({ queryKey: qk.workspaces });
      navigate(`/w/${ws.id}`, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthLayout
      title="Créer un espace de travail"
      subtitle="Vous ne faites partie d’aucun espace pour l’instant. Créez-en un, ou demandez une invitation."
      footer={
        <button type="button" className="link-button" onClick={() => void logoutWithConfirm()}>
          Se déconnecter
        </button>
      }
    >
      <form className="auth__form" onSubmit={submit}>
        <label className="field">
          <span className="field-label">Nom de l’espace</span>
          <input className="input" required autoFocus value={name} placeholder="Mon équipe" onChange={(e) => setName(e.target.value)} />
        </label>
        {error && <div className="form-error">{error}</div>}
        <button type="submit" className="btn btn--primary btn--block" disabled={busy || !name.trim()}>
          {busy ? <Spinner size={15} /> : 'Créer l’espace'}
        </button>
      </form>
    </AuthLayout>
  );
}
