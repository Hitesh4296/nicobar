// Compiled once, so the strip and the validator import the same object.
import c4 from '../../config/lists/c4.json' with { type: 'json' };
import c5 from '../../config/lists/c5.json' with { type: 'json' };
import c7_vocabulary from '../../config/lists/c7_vocabulary.json' with { type: 'json' };
import c8_allow from '../../config/lists/c8_allow.json' with { type: 'json' };
import c8n from '../../config/lists/c8n.json' with { type: 'json' };
import c8o from '../../config/lists/c8o.json' with { type: 'json' };
import charset from '../../config/lists/charset.json' with { type: 'json' };
import strip from '../../config/lists/strip.json' with { type: 'json' };
import warn from '../../config/lists/warn.json' with { type: 'json' };

export const LISTS = { c4, c5, c7_vocabulary, c8_allow, c8n, c8o, charset, strip, warn };
