import type { Transport } from '@dcl/mini-rpc';
import { RPC } from '@dcl/mini-rpc';
import type { NotificationRequest } from '../../../hooks/useSnackbar';

enum Method {
  OPEN_FILE = 'open_file',
  OPEN_DIRECTORY = 'open_directory',
  PUSH_NOTIFICATION = 'push_notification',
  BROADCAST_MOBILE_DEBUG_COMMAND = 'broadcast_mobile_debug_command',
  GET_FEATURE_FLAGS = 'get_feature_flags',
  UPDATE_SDK = 'update_sdk',
  SET_UI_DESIGNER_MODE = 'set_ui_designer_mode',
  OPTIMIZE_SCENE = 'optimize_scene',
}

type Params = {
  [Method.OPEN_FILE]: { path: string };
  [Method.OPEN_DIRECTORY]: { path: string; createIfNotExists?: boolean };
  [Method.PUSH_NOTIFICATION]: { notification: NotificationRequest };
  [Method.BROADCAST_MOBILE_DEBUG_COMMAND]: { cmd: string; args: Record<string, unknown> };
  [Method.GET_FEATURE_FLAGS]: Record<string, never>;
  [Method.UPDATE_SDK]: Record<string, never>;
  [Method.SET_UI_DESIGNER_MODE]: { open: boolean };
  [Method.OPTIMIZE_SCENE]: Record<string, never>;
};

type Result = {
  [Method.OPEN_FILE]: void;
  [Method.OPEN_DIRECTORY]: void;
  [Method.PUSH_NOTIFICATION]: void;
  [Method.BROADCAST_MOBILE_DEBUG_COMMAND]: {
    ok: boolean;
    results: { sessionId: number; ok: boolean; data: unknown }[];
  };
  [Method.GET_FEATURE_FLAGS]: { flags: Record<string, boolean> };
  [Method.UPDATE_SDK]: { ok: boolean };
  [Method.SET_UI_DESIGNER_MODE]: void;
  [Method.OPTIMIZE_SCENE]: void;
};

export class SceneClient extends RPC<Method, Params, Result> {
  constructor(transport: Transport) {
    super('SceneRpcOutbound', transport);
  }

  openFile = (path: string) => {
    return this.request('open_file', { path });
  };

  openDirectory = (path: string, createIfNotExists = false) => {
    return this.request('open_directory', { path, createIfNotExists });
  };

  pushNotification = (notification: NotificationRequest) => {
    return this.request('push_notification', { notification });
  };

  broadcastMobileDebugCommand = (cmd: string, args: Record<string, unknown> = {}) => {
    return this.request('broadcast_mobile_debug_command', { cmd, args });
  };

  /**
   * Pull the host's current feature flags. The host also PUSHES flags via
   * `set_feature_flags`, but that races a slow-to-boot inspector: building the
   * renderer is async, so the scene server can come up after the host's initial
   * push and the flags would be lost. Pulling on server-ready closes that race;
   * the push still covers flags that change afterwards.
   */
  getFeatureFlags = () => {
    return this.request('get_feature_flags', {});
  };

  updateSdk = () => {
    return this.request('update_sdk', {});
  };

  setUiDesignerMode = (open: boolean) => {
    return this.request('set_ui_designer_mode', { open });
  };

  optimizeScene = () => {
    return this.request('optimize_scene', {});
  };
}
