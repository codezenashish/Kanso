import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useWorkspaceToast } from '@/components/ui/workspace-toasts';
import type { WorkspaceNode } from '@/lib/workspace-tree';

type Feedback = {
  key: string;
  message: string;
  applies: (tree: WorkspaceNode[], managedTags: string[]) => boolean;
  undo?: () => void;
};

const failedSaveKey = 'workspace-mutation-save';

export function useWorkspaceFeedback(tree: WorkspaceNode[], flush: () => Promise<boolean>, workspaceSaved: boolean, managedTags: string[]) {
  const { notify, dismissByKey } = useWorkspaceToast();
  const latestTree = useRef(tree);
  const latestTags = useRef(managedTags);
  const pending = useRef<Feedback[]>([]);
  const awaitingRetry = useRef(new Map<string, Feedback>());
  const [feedbackVersion, setFeedbackVersion] = useState(0);

  useLayoutEffect(() => { latestTree.current = tree; latestTags.current = managedTags; }, [tree, managedTags]);

  const publish = useCallback((batch: Feedback[]) => {
    for (const feedback of batch) {
      if (!feedback.applies(latestTree.current, latestTags.current)) continue;
      notify({
        key: feedback.key, kind: 'success', message: feedback.message,
        action: feedback.undo ? { label: 'Undo', run: feedback.undo } : undefined,
      });
    }
  }, [notify]);

  const confirmSaved = useCallback((batch: Feedback[] = []) => {
    const confirmed = [...awaitingRetry.current.values()];
    awaitingRetry.current.clear();
    dismissByKey(failedSaveKey);
    publish([...confirmed, ...batch]);
  }, [dismissByKey, publish]);

  const settle = useCallback(async function settle(batch: Feedback[]) {
    if (await flush()) return confirmSaved(batch);
    for (const feedback of batch) awaitingRetry.current.set(feedback.key, feedback);
    notify({
      key: failedSaveKey, kind: 'error', message: 'Workspace changes could not be saved.',
      action: { label: 'Retry save', run: () => void settle([]) },
    });
  }, [confirmSaved, flush, notify]);

  useEffect(() => {
    if (pending.current.length) void settle(pending.current.splice(0));
  }, [feedbackVersion, settle]);

  useEffect(() => {
    if (workspaceSaved && awaitingRetry.current.size) confirmSaved();
  }, [workspaceSaved, confirmSaved]);

  return {
    latestTree, notify,
    afterSave(feedback: Feedback) {
      pending.current.push(feedback);
      setFeedbackVersion((version) => version + 1);
    },
  };
}
