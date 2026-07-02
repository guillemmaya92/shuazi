// ── i18n / content localization ──
// The DB carries English base columns (meaning, literal, origin, description)
// plus Spanish `_es` variants. `state.lang` ('en' | 'es') selects which one the
// UI shows; Spanish falls back to English when a `_es` value is missing/empty.
//
// Rather than branch at every render site, we rewrite the canonical field
// (`meaning`, …) in place to the active language and stash the English base, so
// the existing templates keep reading `obj.meaning` and switching is lossless.
import { state } from './state.js';

// Localized value of a single content field, e.g. L(row, 'meaning'). Used where
// a derived string map is (re)built rather than a mutable row.
export function L(obj, field) {
  if (!obj) return '';
  if (state.lang === 'es') {
    const es = obj[field + '_es'];
    if (es != null && es !== '') return es;
  }
  return obj[field] ?? '';
}

// Rewrites content fields on `obj` in place to the active language, stashing the
// English base under `__field` the first time so switching back stays lossless.
// Idempotent — safe to call on every language toggle.
export function localizeRow(obj, fields) {
  if (!obj) return obj;
  for (const f of fields) {
    const enKey = '__' + f;
    if (!(enKey in obj)) obj[enKey] = obj[f] ?? '';
    const es = obj[f + '_es'];
    obj[f] = (state.lang === 'es' && es != null && es !== '') ? es : obj[enKey];
  }
  return obj;
}

// Content fields carried by each collection.
export const LANG_FIELDS = {
  chars:      ['meaning'],
  words:      ['meaning'],
  radicals:   ['meaning'],
  components: ['meaning'],
  phrases:    ['literal', 'meaning', 'origin'],
};

// ── Static UI strings ──────────────────────────────────────────────────────
// Chrome (labels, buttons, placeholders) that isn't stored in the DB. Keys are
// shared across languages; a missing Spanish key falls back to English.
const STRINGS = {
  en: {
    // headers / screens
    'app.sub.cards': 'learn by swiping',
    'groups.title': 'HSK Groups',
    'groups.sub': 'Tap a character to see details',
    'slang.title': 'Slang',
    'slang.sub': 'Chinese culture & slang',
    'translator.title': 'Translator',
    'translator.sub': 'Any language → Chinese & pinyin',
    'profile.title': 'Profile',
    'profile.sub': 'Your progress overview',
    // deck swipe hints
    'hint.left': '← Left',
    'hint.review': '↑ Review',
    'hint.known': 'Known →',
    'hint.swipeLeft': '← swipe left',
    'hint.swipeRight': 'swipe right →',
    // stats
    'stat.left': 'Left',
    'stat.known': 'Known',
    'stat.review': 'Review',
    // search
    'search.ph': 'Search…',
    'search.hint': 'Use quotes (" ") to search for an exact character',
    // translator
    'tr.hanzi': 'Hanzi translation',
    'tr.tokenized': 'Tokenized translation',
    'tr.placeholder': 'Type in any language...',
    'tr.pullClear': 'Pull to clear',
    'tr.releaseClear': 'Release to clear',
    'tr.error': 'Could not translate: ',
    'history.pinned': 'Pinned',
    'history.recents': 'Recents',
    'history.empty': 'No conversations yet.',
    'history.clear': 'Clear',
    // groups pull-to-clear
    'filters.pullClear': 'Pull to clear filters',
    'filters.releaseClear': 'Release to clear filters',
    // tab bar
    'tab.cards': 'Cards',
    'tab.groups': 'Groups',
    'tab.slang': 'Slang',
    'tab.translate': 'Translate',
    'tab.profile': 'Profile',
    // settings
    'settings.title': 'Settings',
    'settings.account': 'Account',
    'settings.invite': 'Invite a friend',
    'settings.contact': 'Contact',
    'settings.language': 'Language',
    'settings.terms': 'Terms & Conditions',
    'settings.privacy': 'Privacy Policy',
    'settings.hanzi': 'Hanzi',
    // detail labels
    'lbl.char': 'Char',
    'lbl.hanzi': 'Hanzi',
    'lbl.pinyin': 'Pinyin',
    'lbl.radical': 'Radical',
    'lbl.level': 'Level',
    'lbl.meaning': 'Meaning',
    'lbl.components': 'Components',
    'lbl.strokes': 'Strokes',
    'lbl.component': 'Component',
    'lbl.word': 'Word',
    'lbl.pos': 'POS',
    'lbl.characters': 'Characters',
    'lbl.phrases': 'Phrases',
    'lbl.compoundWords': 'Compound words',
    'lbl.compoundChars': 'Compound characters',
    'lbl.signedInAs': 'Signed in as',
    'lbl.overallProgress': 'Overall progress',
    'badge.components': 'Components',
    'word.loading': 'Loading…',
    'card.tapReveal': 'Tap center to reveal',
    'card.moreInfo': 'Tap right → for more info',
    'card.moreInfoAria': 'More info',
    'card.example': 'Example',
    // buttons
    'btn.signOut': 'Sign out',
    'btn.signIn': 'Sign in',
    'btn.register': 'Register',
    'badge.signUp': 'Sign up',
    'msg.signUpFailed': 'Sign up failed. Please try again.',
    'msg.checkEmail': 'Check your email to confirm!',
    'msg.emailRegistered': 'This email is already registered. Try signing in.',
    // misc
    'msg.known': 'known',
    'msg.availablePro': 'is available with shuazi Pro',
    'msg.unlocksHsk': 'Unlocks HSK 1–6',
    'filter.hintHsk': 'Select the HSK levels to include in your card deck.',
    'filter.hintStatus': 'Select which card statuses to include in your deck.',
    // groups screen
    'groups.filtersTitle': 'Filters',
    'groups.filtersHint': 'Long-press to filter characters',
    'groups.markHint': 'Long-press to mark known / review',
    'badge.radicals': 'Radicals',
    'count.radicals': 'radicals',
    'count.components': 'components',
    // profile
    'profile.game': 'Game',
    'profile.progress': 'Progress',
    'profile.filters': 'Filters',
    'groups.words': 'Words',
    'groups.characters': 'Characters',
    'status.left': 'Left',
    'status.know': 'Know',
    'status.review': 'Review',
    'progress.hintWords': 'From a typical Chinese text — Top 1000 words cover 75%.\nMark words as learned to see your progress.',
    'progress.hintChars': 'From a typical Chinese text — Top 500 chars cover 75%.\nMark characters as learned to see your progress.',
    // auth
    'auth.google': 'Continue with Google',
    'auth.email': 'Email',
    'auth.password': 'Password',
    'auth.or': 'or',
    'auth.forgot': 'Forgot password?',
    'auth.enterEmail': 'Enter your email above first.',
    'auth.resetSent': 'Check your email for a reset link.',
    'auth.noAccount': 'No account found with that email.',
    'auth.useGoogle': 'This account uses Google — tap “Continue with Google”.',
    'pwreset.title': 'Set a new password',
    'pwreset.new': 'New password',
    'pwreset.save': 'Save password',
    'pwreset.short': 'Password must be at least 6 characters.',
    'pwreset.done': 'Password updated — you are signed in.',
    'pwreset.expiredTitle': 'Link expired',
    'pwreset.expired': 'This reset link has already been used or has expired. Request a new one from the sign-in screen.',
    'pwreset.ok': 'Got it',
    // pro
    'pro.title': 'Shuazi Pro',
    'pro.unlockedAll': 'Pro — all levels unlocked',
    'pro.upgradeTooltip': 'Upgrade to Pro to unlock',
    'pro.bubbleTitle': 'Grab me a bubble tea',
    'pro.bubbleDesc': 'Help keep Shuazi alive (and me awake 😅) — grab us a sweet bubble tea and unlock:',
    'pro.perk1': 'HSK 1–6 — all 1,500+ characters, forever',
    'pro.perk2': 'Cross-device sync — pick up where you left off',
    'pro.perk3': 'Built-in translator — with word segmentation',
    'pro.support': 'Support',
    // account management
    'account.reset': 'Reset progress',
    'account.delete': 'Delete account',
    'reset.title': 'Reset all progress?',
    'reset.desc': 'This will permanently delete all your Known and Review marks. This action cannot be undone.',
    'reset.confirm': 'Yes, reset everything',
    'delacct.title': 'Delete your account?',
    'delacct.desc': 'This permanently deletes your account, progress and saved translations. This action cannot be undone.',
    'delacct.confirm': 'Yes, delete my account',
    'common.cancel': 'Cancel',
    'common.total': 'Total',
    // sort modes
    'sort.pinyin': 'Pinyin',
    'sort.stroke': 'Stroke',
    'sort.hsk': 'HSK',
    'sort.frequency': 'Frequency',
    'sort.productive': 'Productive',
    // PWA install banner + instruction sheets
    'pwa.ariaBanner': 'Install app',
    'pwa.title': 'Install Shuazi',
    'pwa.subtitle': 'Add it to your home screen',
    'pwa.install': 'Install',
    'pwa.dismiss': 'Dismiss',
    'pwa.ariaSheet': 'Install instructions',
    'pwa.gotit': 'Got it',
    'pwa.iosStep1': 'Tap the Share button',
    'pwa.iosStep2': 'Choose “Add to Home Screen”',
    'pwa.iosStep3': 'Tap “Add” to finish',
    'pwa.iosNote': 'Open this page in <strong>Safari</strong>, then tap Share → “Add to Home Screen”.',
    'pwa.andStep1': 'Open the browser menu',
    'pwa.andStep2': 'Tap “Install app” / “Add to Home screen”',
    'pwa.andStep3': 'Confirm to finish',
    // Onboarding coach (coach.js)
    'coach.groups': 'Long-press a character to mark',
    // Stroke order (stroke-order.js)
    'stroke.title': 'Stroke order',
    'stroke.view': 'View stroke order',
    'stroke.replay': 'Replay',
    'stroke.write': 'Practice writing',
    'stroke.radical': 'Highlight radical',
    'stroke.prev': 'Previous character',
    'stroke.next': 'Next character',
    'stroke.error': 'Could not load the stroke data. Check your connection and try again.',
  },
  es: {
    'app.sub.cards': 'aprende deslizando',
    'groups.title': 'Grupos HSK',
    'groups.sub': 'Toca para ver detalles',
    'slang.title': 'Jerga',
    'slang.sub': 'Cultura y modismos chinos',
    'translator.title': 'Traductor',
    'translator.sub': 'Cualquier idioma → chino y pinyin',
    'profile.title': 'Perfil',
    'profile.sub': 'Resumen de tu progreso',
    'hint.left': '← Faltan',
    'hint.review': '↑ Repaso',
    'hint.known': 'Hecho →',
    'hint.swipeLeft': '← desliza a la izquierda',
    'hint.swipeRight': 'desliza a la derecha →',
    'stat.left': 'Faltan',
    'stat.known': 'Hecho',
    'stat.review': 'Repaso',
    'search.ph': 'Buscar…',
    'search.hint': 'Usa comillas (" ") para buscar un carácter exacto',
    'tr.hanzi': 'Traducción a hanzi',
    'tr.tokenized': 'Traducción por palabras',
    'tr.placeholder': 'Escribe en cualquier idioma...',
    'tr.pullClear': 'Desliza para borrar',
    'tr.releaseClear': 'Suelta para borrar',
    'tr.error': 'No se pudo traducir: ',
    'history.pinned': 'Fijados',
    'history.recents': 'Recientes',
    'history.empty': 'Aún no hay conversaciones.',
    'history.clear': 'Borrar',
    'filters.pullClear': 'Desliza para borrar filtros',
    'filters.releaseClear': 'Suelta para borrar filtros',
    'tab.cards': 'Cartas',
    'tab.groups': 'Grupos',
    'tab.slang': 'Jerga',
    'tab.translate': 'Traducir',
    'tab.profile': 'Perfil',
    'settings.title': 'Ajustes',
    'settings.account': 'Cuenta',
    'settings.invite': 'Invitar a un amigo',
    'settings.contact': 'Contacto',
    'settings.language': 'Idioma',
    'settings.terms': 'Términos y condiciones',
    'settings.privacy': 'Política de privacidad',
    'settings.hanzi': 'Hanzi',
    'lbl.char': 'Char',
    'lbl.hanzi': 'Hanzi',
    'lbl.pinyin': 'Pinyin',
    'lbl.radical': 'Radical',
    'lbl.level': 'Nivel',
    'lbl.meaning': 'Significado',
    'lbl.components': 'Componentes',
    'lbl.strokes': 'Trazos',
    'lbl.component': 'Componente',
    'lbl.word': 'Palabra',
    'lbl.pos': 'Categoría',
    'lbl.characters': 'Caracteres',
    'lbl.phrases': 'Frases',
    'lbl.compoundWords': 'Palabras compuestas',
    'lbl.compoundChars': 'Caracteres compuestos',
    'lbl.signedInAs': 'Sesión iniciada',
    'lbl.overallProgress': 'Progreso general',
    'badge.components': 'Componentes',
    'word.loading': 'Cargando…',
    'card.tapReveal': 'Toca el centro para revelar',
    'card.moreInfo': 'Toca derecha → para más info',
    'card.moreInfoAria': 'Más info',
    'card.example': 'Ejemplo',
    'btn.signOut': 'Cerrar sesión',
    'btn.signIn': 'Iniciar sesión',
    'btn.register': 'Registrarse',
    'badge.signUp': 'Registrarse',
    'msg.signUpFailed': 'No se pudo registrar. Inténtalo de nuevo.',
    'msg.checkEmail': 'Revisa tu correo para confirmar',
    'msg.emailRegistered': 'Este correo ya está registrado. Inicia sesión.',
    'msg.known': 'hecho',
    'msg.availablePro': 'está disponible con shuazi Pro',
    'msg.unlocksHsk': 'Desbloquea HSK 1–6',
    'filter.hintHsk': 'Selecciona los niveles HSK que incluir en tu mazo.',
    'filter.hintStatus': 'Selecciona qué estados de carta incluir en tu mazo.',
    'groups.filtersTitle': 'Filtros',
    'groups.filtersHint': 'Mantén pulsado para filtrar caracteres',
    'groups.markHint': 'Mantén pulsado para marcar',
    'badge.radicals': 'Radicales',
    'count.radicals': 'radicales',
    'count.components': 'componentes',
    'profile.game': 'Modo',
    'profile.progress': 'Progreso',
    'profile.filters': 'Filtros',
    'groups.words': 'Palabras',
    'groups.characters': 'Caracteres',
    'status.left': 'Faltan',
    'status.know': 'Hecho',
    'status.review': 'Repaso',
    'progress.hintWords': 'Sobre un texto chino común — Top 1000 palabras cubren el 75%.\nMarca palabras como aprendidas para ver tu progreso.',
    'progress.hintChars': 'Sobre un texto chino común — Top 500 caracteres cubren el 75%.\nMarca caracteres como aprendidos para ver tu progreso.',
    'auth.google': 'Continuar con Google',
    'auth.email': 'Correo',
    'auth.password': 'Contraseña',
    'auth.or': 'o',
    'auth.forgot': '¿Olvidaste tu contraseña?',
    'auth.enterEmail': 'Introduce tu correo arriba primero.',
    'auth.resetSent': 'Revisa tu correo para el enlace de restablecimiento.',
    'auth.noAccount': 'No hay ninguna cuenta con ese correo.',
    'auth.useGoogle': 'Esta cuenta usa Google — pulsa “Continuar con Google”.',
    'pwreset.title': 'Establece una nueva contraseña',
    'pwreset.new': 'Nueva contraseña',
    'pwreset.save': 'Guardar contraseña',
    'pwreset.short': 'La contraseña debe tener al menos 6 caracteres.',
    'pwreset.done': 'Contraseña actualizada — sesión iniciada.',
    'pwreset.expiredTitle': 'Enlace caducado',
    'pwreset.expired': 'Este enlace de restablecimiento ya se usó o ha caducado. Pide uno nuevo desde la pantalla de inicio de sesión.',
    'pwreset.ok': 'Entendido',
    'pro.title': 'Shuazi Pro',
    'pro.unlockedAll': 'Pro — todos los niveles desbloqueados',
    'pro.upgradeTooltip': 'Hazte Pro para desbloquear',
    'pro.bubbleTitle': 'Invítame a un bubble tea',
    'pro.bubbleDesc': 'Ayuda a mantener Shuazi vivo (y a mí despierto 😅) — invítanos a un bubble tea y desbloquea:',
    'pro.perk1': 'HSK 1–6 — los más de 1500 caracteres, para siempre',
    'pro.perk2': 'Sincroniza dispositivos — continúa donde lo dejaste',
    'pro.perk3': 'Traductor integrado — con segmentación de palabras',
    'pro.support': 'Apoyar',
    'account.reset': 'Restablecer progreso',
    'account.delete': 'Eliminar cuenta',
    'reset.title': '¿Restablecer todo el progreso?',
    'reset.desc': 'Esto eliminará permanentemente todas tus marcas de Aprendidas y Repaso. Esta acción no se puede deshacer.',
    'reset.confirm': 'Sí, restablecer todo',
    'delacct.title': '¿Eliminar tu cuenta?',
    'delacct.desc': 'Esto elimina permanentemente tu cuenta, tu progreso y las traducciones guardadas. Esta acción no se puede deshacer.',
    'delacct.confirm': 'Sí, eliminar mi cuenta',
    'common.cancel': 'Cancelar',
    'common.total': 'Total',
    'sort.pinyin': 'Pinyin',
    'sort.stroke': 'Trazos',
    'sort.hsk': 'HSK',
    'sort.frequency': 'Frecuencia',
    'sort.productive': 'Productivo',
    'pwa.ariaBanner': 'Instalar app',
    'pwa.title': 'Instala Shuazi',
    'pwa.subtitle': 'Añádela a tu pantalla de inicio',
    'pwa.install': 'Instalar',
    'pwa.dismiss': 'Descartar',
    'pwa.ariaSheet': 'Instrucciones de instalación',
    'pwa.gotit': 'Entendido',
    'pwa.iosStep1': 'Toca el botón Compartir',
    'pwa.iosStep2': 'Elige “Añadir a pantalla de inicio”',
    'pwa.iosStep3': 'Toca “Añadir” para terminar',
    'pwa.iosNote': 'Abre esta página en <strong>Safari</strong> y toca Compartir → “Añadir a pantalla de inicio”.',
    'pwa.andStep1': 'Abre el menú del navegador',
    'pwa.andStep2': 'Toca “Instalar app” / “Añadir a pantalla de inicio”',
    'pwa.andStep3': 'Confirma para terminar',
    // Onboarding coach (coach.js)
    'coach.groups': 'Mantén pulsado un carácter para marcar',
    // Stroke order (stroke-order.js)
    'stroke.title': 'Orden de trazos',
    'stroke.view': 'Ver orden de trazos',
    'stroke.replay': 'Repetir',
    'stroke.write': 'Practicar escritura',
    'stroke.radical': 'Resaltar radical',
    'stroke.prev': 'Carácter anterior',
    'stroke.next': 'Carácter siguiente',
    'stroke.error': 'No se pudieron cargar los trazos. Revisa tu conexión e inténtalo de nuevo.',
  },
};

// Translate a UI-string key to the active language (English fallback).
export function t(key) {
  const dict = STRINGS[state.lang] || STRINGS.en;
  return dict[key] ?? STRINGS.en[key] ?? key;
}

// Apply translations to a DOM subtree. Elements opt in via attributes:
//   data-i18n="key"       → textContent
//   data-i18n-ph="key"    → placeholder
//   data-i18n-aria="key"  → aria-label
export function applyStaticTranslations(root = document) {
  if (root === document) document.documentElement.lang = state.lang;
  root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.getAttribute('data-i18n')); });
  root.querySelectorAll('[data-i18n-ph]').forEach(el => { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph'))); });
  root.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'))); });
}

// Re-localize every loaded collection, lazy cache and the live deck to the
// active language. Call after flipping `state.lang`, then re-render.
export function applyLanguage() {
  const each = (arr, fields) => { if (Array.isArray(arr)) for (const o of arr) localizeRow(o, fields); };
  each(state.CHARACTERS, LANG_FIELDS.chars);
  each(state.WORDS,      LANG_FIELDS.words);
  each(state.RADICALS,   LANG_FIELDS.radicals);
  each(state.COMPONENTS, LANG_FIELDS.components);
  each(state.PHRASES,    LANG_FIELDS.phrases);
  each(state.deck,       ['meaning']);              // live char/word cards
  each(state.slangDeck,  LANG_FIELDS.phrases);
  Object.values(state.wordsByChar).forEach(list => each(list, ['meaning']));
  Object.values(state.phrasesByWord).forEach(list => each(list, ['meaning']));
  // POS descriptions are a pos→string map; rebuild it from the raw rows.
  if (Array.isArray(state._posTags)) {
    state.POS_TAGS = Object.fromEntries(state._posTags.map(tag => [tag.pos, L(tag, 'description')]));
  }
}
