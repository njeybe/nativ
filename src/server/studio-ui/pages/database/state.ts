// Database Studio state and small helpers, private to the Database page.
export const databaseStateScript = String.raw`  var ENGINE_LABEL = { postgresql: 'PostgreSQL', mysql: 'MySQL', sqlite: 'SQLite', mongodb: 'MongoDB', firestore: 'Firebase Firestore' };
  var NOSQL = { mongodb: true, firestore: true };
  var state = {
    tab: 'explorer',
    envMode: 'dev',
    dbStarted: false,
    loading: true,
    status: null,
    schema: { devTables: [], prodTables: [] },
    diff: null,
    diffError: null,
    diffTarget: 'prod',
    search: '',
    mobileEnv: 'dev',
    sql: '',
    scriptLang: 'sql',
    dataEnv: 'dev',
    dataEntity: '',
    dataPage: 1,
    dataLimit: 25,
    dataSort: '',
    dataOrder: 'asc',
    dataSearch: '',
    dataLoading: false,
    dataResult: null,
    dataError: null,
    editingPk: null,
    pendingMutation: null,
    envInfo: null
  };
  // Media fields rendered in the current view, referenced by index from IMAGE badges.
  var mediaRegistry = [];

  function isCollection(t) { return !!t && t.entityType === 'collection'; }
  function entityCount(s) { return s.entityCount != null ? s.entityCount : s.tableCount; }
  function entityNoun(s, plural) {
    var coll = s && (s.entityType === 'collection' || NOSQL[s.engine]);
    return coll ? (plural ? 'Collections' : 'Collection') : (plural ? 'Tables' : 'Table');
  }
  /** Noun for drift views: collections when the compared Dev database is a document store. */
  function driftNoun(plural) {
    var dev = state.status && state.status.dev;
    return entityNoun(dev, plural).toLowerCase();
  }
  function isPreviewableUrl(u) { return typeof u === 'string' && /^https?:\/\//i.test(u); }

`;

// Loads on first visit only: the page connects to live databases.
export const databaseRegisterScript = String.raw`
  Studio.registerPage('database', {
    deps: [],
    onShow: function () {
      if (!state.dbStarted) { state.dbStarted = true; load(false); } else renderDb();
    }
  });
`;
