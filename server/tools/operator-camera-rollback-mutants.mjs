export function mutateCamera(source, name) {
  if (!name) return source;
  const changes = {
    pending: ['operatorPhotoCamera.pending?.getTracks().forEach((track) => track.stop());', ''],
    basic: ['return /Android/i.test(agent.userAgent)', 'return !/Android/i.test(agent.userAgent)'],
    retry: ['if (!isCurrent() || !["NotFoundError", "OverconstrainedError"].includes(error?.name)) throw error;',
      'if (!isCurrent() || ["NotAllowedError", "SecurityError"].includes(error?.name)) throw error;'],
    hidden: [' || document.visibilityState === "hidden"', ''],
    stale: ['if (operatorPhotoCamera.pending === stream) operatorPhotoCamera.pending = null;', 'operatorPhotoCamera.pending = null;'],
    selection: ['if (!isCurrent() || !["NotFoundError", "OverconstrainedError"].includes(error?.name)) throw error;', 'throw error;'],
  };
  const change = changes[name];
  if (!change || !source.includes(change[0])) throw new Error(`Missing mutation anchor: ${name}`);
  return source.replace(change[0], change[1]);
}
