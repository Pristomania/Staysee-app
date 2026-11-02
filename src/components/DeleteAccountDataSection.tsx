import { ConfirmedDelete } from './ConfirmedDelete';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { deleteAccountData } from '../lib/deleteAccountData';
import { supabaseAccountDataDeps } from '../lib/deleteAccountDataDeps';
import { ROOM_COPY } from '../lib/roomCopy';

/**
 * "Delete the data of the account": conversations, notes and all memory go, the account stays clean. Only the free plan
 * has it (there the memory is not shown, so it could not be deleted piece by piece); the paid plans delete memory on
 * the privacy screen. Deleting the account itself is a different button, DeleteRoomSection.
 */
export function DeleteAccountDataSection() {
  const { user } = useAuth();
  const { setConversations, setMessages, setCurrentConversation } = useApp();

  return (
    <ConfirmedDelete
      title={ROOM_COPY.deleteDataTitle}
      hint={ROOM_COPY.deleteDataHint}
      buttonLabel={ROOM_COPY.deleteDataButton}
      doneText={ROOM_COPY.deleteDataDone}
      onRun={async () => {
        if (!user) return false;
        const ok = await deleteAccountData(user.id, supabaseAccountDataDeps);
        if (ok) {
          setConversations([]);
          setMessages([]);
          setCurrentConversation(null);
        }
        return ok;
      }}
    />
  );
}
