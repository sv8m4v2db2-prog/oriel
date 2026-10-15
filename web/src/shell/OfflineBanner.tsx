import { WifiOff } from 'lucide-react';
import { useOffline } from './status';

export function OfflineBanner() {
  const offline = useOffline();
  if (!offline) return null;
  return (
    <div className="offline-banner" role="status">
      <WifiOff size={15} />
      <span>
        Hors ligne — vos modifications restent enregistrées sur cet appareil et seront synchronisées dès le retour de la
        connexion.
      </span>
    </div>
  );
}
