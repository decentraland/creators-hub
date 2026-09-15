import { configureStore } from '@reduxjs/toolkit';
import * as ai from '../../src/modules/store/ai';
import * as editor from '../../src/modules/store/editor';
import * as snackbar from '../../src/modules/store/snackbar';
import * as translations from '../../src/modules/store/translation';
import * as workspace from '../../src/modules/store/workspace';
import * as deployment from '../../src/modules/store/deployment';
import * as analytics from '../../src/modules/store/analytics';
import * as ens from '../../src/modules/store/ens';
import * as land from '../../src/modules/store/land';
import * as management from '../../src/modules/store/management';
import * as featureFlags from '../../src/modules/store/featureFlags';
import * as settings from '../../src/modules/store/settings';
import * as defaultEditor from '../../src/modules/store/defaultEditor';
import * as profiles from '../../src/modules/store/profiles';
import * as placeAnalytics from '../../src/modules/store/placeAnalytics';
import * as optimizer from '../../src/modules/store/optimizer';

/** Mirrors the app's root reducer, so a component under test finds every slice. */
export const createTestStore = () =>
  configureStore({
    reducer: {
      ai: ai.reducer,
      editor: editor.reducer,
      snackbar: snackbar.reducer,
      translation: translations.reducer,
      workspace: workspace.reducer,
      deployment: deployment.reducer,
      analytics: analytics.reducer,
      ens: ens.reducer,
      land: land.reducer,
      management: management.reducer,
      featureFlags: featureFlags.reducer,
      settings: settings.reducer,
      defaultEditor: defaultEditor.reducer,
      profiles: profiles.reducer,
      placeAnalytics: placeAnalytics.reducer,
      optimizer: optimizer.reducer,
    },
    middleware: getDefaultMiddleware =>
      getDefaultMiddleware({
        thunk: true,
        serializableCheck: false,
      }),
  });

export type TestStore = ReturnType<typeof createTestStore>;
