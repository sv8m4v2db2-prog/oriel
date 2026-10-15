import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { EmptyState } from '../components/common';

export function NotFoundPage() {
  return (
    <div className="center-screen">
      <EmptyState
        icon={<Compass size={28} />}
        title="Page introuvable"
        action={
          <Link to="/" className="btn btn--primary">
            Retour à l’accueil
          </Link>
        }
      >
        L’adresse demandée n’existe pas ou n’est plus disponible.
      </EmptyState>
    </div>
  );
}
