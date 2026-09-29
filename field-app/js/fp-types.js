// Lia Field — fp-types.js
//
// The fall protection equipment catalogue: every type, and the pass/fail
// parameters that apply to it. Not every type has the same parameters — a
// climbing belt is checked for leather and stitching, a body harness is not —
// so the type the tech picks is what decides the questions he is asked.
//
// TWO ANSWER STYLES
//
//   pass_fail  a component, answered Pass or Fail
//   yes_no     a question, answered Yes or No
//
// and `pass_answer` says which answer is a pass. That last part matters: "has
// the impact indicator been activated?" fails on YES. Every other question in
// the list passes on the affirmative, so the polarity has to be carried per
// check rather than assumed.
//
// A type with no impact indicator simply does not carry that check — there is
// no third "not applicable" state for a tech to leave hanging.
//
// THIS LIST IS THE FALLBACK, NOT THE TRUTH
//
// The account's real catalogue comes down from fp_type_catalog() and is cached
// on the device; a lead can change a checklist or add checks to it at any time.
// This baked-in copy is what a phone uses before its first sync, so a brand new
// install is never stuck without a checklist. It is generated from the same
// table as the seed in supabase/11_fp_equipment_types.sql, and
// field-app/test/fp-types.test.mjs fails if the two drift apart.
//
// Classic script, same as the rest of the field app: no build step, no modules.

(function (root) {
  'use strict';

  var BUILT_IN = [
    {
      slug: "crane_lift_sling",
      name: "Crane lift sling",
      sort_order: 1,
      checks: [
        { code: "labels",                prompt: "Are all labels and markings present, secured and legible?", answer_style: "yes_no",     pass_answer: true,  required: true },
        { code: "webbing",               prompt: "Webbing / rope / cable",                            answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "stitching",             prompt: "Stitching / swaging",                               answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "loop_protectors",       prompt: "Loop protectors / thimble",                         answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "snap_hooks",            prompt: "Snap hooks / carabiners",                           answer_style: "pass_fail",  pass_answer: true,  required: true },
      ],
    },
    {
      slug: "tie_off_adaptor",
      name: "Tie off adaptor",
      sort_order: 2,
      checks: [
        { code: "labels",                prompt: "Are all labels and markings present, secured and legible?", answer_style: "yes_no",     pass_answer: true,  required: true },
        { code: "impact_indicator",      prompt: "Has the impact indicator been activated?",          answer_style: "yes_no",     pass_answer: false, required: true },
        { code: "webbing",               prompt: "Webbing / rope / cable",                            answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "stitching",             prompt: "Stitching / swaging",                               answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "wear_pad",              prompt: "Wear pad / wear sleeve",                            answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "o_rings",               prompt: "O-rings / D-rings",                                 answer_style: "pass_fail",  pass_answer: true,  required: true },
      ],
    },
    {
      slug: "rescue_device_r550",
      name: "Rescue device — R550",
      sort_order: 3,
      checks: [
        { code: "labels",                prompt: "Are all labels and markings present, secured and legible?", answer_style: "yes_no",     pass_answer: true,  required: true },
        { code: "impact_indicator",      prompt: "Has the impact indicator been activated?",          answer_style: "yes_no",     pass_answer: false, required: true },
        { code: "stitching",             prompt: "Stitching / swaging",                               answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "snap_hooks",            prompt: "Snap hooks / carabiners",                           answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "kernmantle_lifeline",   prompt: "Kernmantle rope lifeline",                          answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "housing_hub",           prompt: "Housing / rescue hub",                              answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "working_mechanism",     prompt: "Working mechanism",                                 answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "camming_cleats",        prompt: "Camming cleats / pigtail",                          answer_style: "pass_fail",  pass_answer: true,  required: true },
      ],
    },
    {
      slug: "temporary_horizontal_lifeline",
      name: "Temporary horizontal lifeline",
      sort_order: 4,
      checks: [
        { code: "labels",                prompt: "Are all labels and markings present, secured and legible?", answer_style: "yes_no",     pass_answer: true,  required: true },
        { code: "impact_indicator",      prompt: "Has the impact indicator been activated?",          answer_style: "yes_no",     pass_answer: false, required: true },
        { code: "webbing",               prompt: "Webbing / rope / cable",                            answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "stitching",             prompt: "Stitching / swaging",                               answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "loop_protectors",       prompt: "Loop protectors / thimble",                         answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "snap_hooks",            prompt: "Snap hooks / carabiners",                           answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "energy_absorber",       prompt: "Energy absorber",                                   answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "lifeline_tensioner",    prompt: "Lifeline tensioner",                                answer_style: "pass_fail",  pass_answer: true,  required: true },
      ],
    },
    {
      slug: "vertical_lifeline_arrester",
      name: "Vertical lifelines and fall arresters",
      sort_order: 5,
      checks: [
        { code: "labels",                prompt: "Are all labels and markings present, secured and legible?", answer_style: "yes_no",     pass_answer: true,  required: true },
        { code: "impact_indicator",      prompt: "Has the impact indicator been activated?",          answer_style: "yes_no",     pass_answer: false, required: true },
        { code: "snap_hooks",            prompt: "Snap hooks / carabiners",                           answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "working_mechanism",     prompt: "Working mechanism",                                 answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "arrester_enclosure",    prompt: "Arrester enclosure exterior",                       answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "rope_retainer",         prompt: "Rope retainer",                                     answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "rope_lifeline",         prompt: "Rope lifeline",                                     answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "splices_thimbles",      prompt: "Splices / thimbles",                                answer_style: "pass_fail",  pass_answer: true,  required: true },
      ],
    },
    {
      slug: "positioning_lanyard",
      name: "Positioning lanyard",
      sort_order: 6,
      checks: [
        { code: "labels",                prompt: "Are all labels and markings present, secured and legible?", answer_style: "yes_no",     pass_answer: true,  required: true },
        { code: "webbing",               prompt: "Webbing / rope / cable",                            answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "stitching",             prompt: "Stitching / swaging",                               answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "loop_protectors",       prompt: "Loop protectors / thimble",                         answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "snap_hooks",            prompt: "Snap hooks / carabiners",                           answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "energy_absorber",       prompt: "Energy absorber",                                   answer_style: "pass_fail",  pass_answer: true,  required: true },
      ],
    },
    {
      slug: "positioning_strap",
      name: "Positioning strap",
      sort_order: 7,
      checks: [
        { code: "labels",                prompt: "Are all labels and markings present, secured and legible?", answer_style: "yes_no",     pass_answer: true,  required: true },
        { code: "warning_center",        prompt: "Warning center not extended",                       answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "strap_material",        prompt: "Strap material",                                    answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "rivets_bolts",          prompt: "Rivets / bolts",                                    answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "snaphooks",             prompt: "Snaphooks",                                         answer_style: "pass_fail",  pass_answer: true,  required: true },
      ],
    },
    {
      slug: "self_rescue_device",
      name: "Self rescue device",
      sort_order: 8,
      checks: [
        { code: "labels",                prompt: "Are all labels and markings present, secured and legible?", answer_style: "yes_no",     pass_answer: true,  required: true },
        { code: "impact_indicator",      prompt: "Has the impact indicator been activated?",          answer_style: "yes_no",     pass_answer: false, required: true },
        { code: "locking_pin",           prompt: "Locking pin and button",                            answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "d_rings",               prompt: "D-ring(s)",                                         answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "device_housing",        prompt: "Device housing",                                    answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "rescue_cable",          prompt: "Assisted rescue cable",                             answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "rescue_handle",         prompt: "Assisted rescue handle",                            answer_style: "pass_fail",  pass_answer: true,  required: true },
      ],
    },
    {
      slug: "self_rescue_with_bag",
      name: "Self rescue with bag",
      sort_order: 9,
      checks: [
        { code: "labels",                prompt: "Are all labels and markings present, secured and legible?", answer_style: "yes_no",     pass_answer: true,  required: true },
        { code: "impact_indicator",      prompt: "Has the impact indicator been activated?",          answer_style: "yes_no",     pass_answer: false, required: true },
        { code: "locking_pin",           prompt: "Locking pin and button",                            answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "d_rings",               prompt: "D-ring(s)",                                         answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "device_housing",        prompt: "Device housing",                                    answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "rescue_cable",          prompt: "Assisted rescue cable",                             answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "rescue_handle",         prompt: "Assisted rescue handle",                            answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "bag",                   prompt: "Bag",                                               answer_style: "pass_fail",  pass_answer: true,  required: true },
      ],
    },
    {
      slug: "pole_climbing_device",
      name: "Pole climbing device",
      sort_order: 10,
      checks: [
        { code: "labels",                prompt: "Are all labels and markings present, secured and legible?", answer_style: "yes_no",     pass_answer: true,  required: true },
        { code: "warning_center",        prompt: "Warning center not extended",                       answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "strap_material",        prompt: "Strap material",                                    answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "rivets_bolts",          prompt: "Rivets / bolts",                                    answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "snaphooks",             prompt: "Snaphooks",                                         answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "stopping_cleat",        prompt: "Stopping cleat",                                    answer_style: "pass_fail",  pass_answer: true,  required: true },
      ],
    },
    {
      slug: "srl",
      name: "SRL (self-retracting lifeline)",
      sort_order: 11,
      checks: [
        { code: "labels",                prompt: "Are all labels and markings present, secured and legible?", answer_style: "yes_no",     pass_answer: true,  required: true },
        { code: "impact_indicator",      prompt: "Has the impact indicator been activated?",          answer_style: "yes_no",     pass_answer: false, required: true },
        { code: "webbing",               prompt: "Webbing / rope / cable",                            answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "loop_protectors",       prompt: "Loop protectors / thimble",                         answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "housing_hub",           prompt: "Housing / rescue hub",                              answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "working_mechanism",     prompt: "Working mechanism",                                 answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "energy_absorber",       prompt: "Energy absorber",                                   answer_style: "pass_fail",  pass_answer: true,  required: true },
      ],
    },
    {
      slug: "body_harness",
      name: "Body harness",
      sort_order: 12,
      checks: [
        { code: "labels",                prompt: "Are all labels and markings present, secured and legible?", answer_style: "yes_no",     pass_answer: true,  required: true },
        { code: "impact_indicator",      prompt: "Has the impact indicator been activated?",          answer_style: "yes_no",     pass_answer: false, required: true },
        { code: "webbing",               prompt: "Webbing / rope / cable",                            answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "stitching",             prompt: "Stitching / swaging",                               answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "o_rings",               prompt: "O-rings / D-rings",                                 answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "top_bottom_connectors", prompt: "Top and bottom connectors",                         answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "buckles",               prompt: "Buckles",                                           answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "trauma_strap",          prompt: "Suspension trauma strap",                           answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "strap_keepers",         prompt: "Strap keepers / lanyard",                           answer_style: "pass_fail",  pass_answer: true,  required: true },
      ],
    },
    {
      slug: "lanyard",
      name: "Lanyard",
      sort_order: 13,
      checks: [
        { code: "labels",                prompt: "Are all labels and markings present, secured and legible?", answer_style: "yes_no",     pass_answer: true,  required: true },
        { code: "impact_indicator",      prompt: "Has the impact indicator been activated?",          answer_style: "yes_no",     pass_answer: false, required: true },
        { code: "webbing",               prompt: "Webbing / rope / cable",                            answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "stitching",             prompt: "Stitching / swaging",                               answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "loop_protectors",       prompt: "Loop protectors / thimble",                         answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "snap_hooks",            prompt: "Snap hooks / carabiners",                           answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "energy_absorber",       prompt: "Energy absorber",                                   answer_style: "pass_fail",  pass_answer: true,  required: true },
      ],
    },
    {
      slug: "climbing_belt",
      name: "Climbing belt",
      sort_order: 14,
      checks: [
        { code: "labels",                prompt: "Are all labels and markings present, secured and legible?", answer_style: "yes_no",     pass_answer: true,  required: true },
        { code: "d_rings",               prompt: "D-ring(s)",                                         answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "buckles",               prompt: "Buckles",                                           answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "leather_stitching",     prompt: "Leather and stitching",                             answer_style: "pass_fail",  pass_answer: true,  required: true },
        { code: "tool_pouches",          prompt: "Tool pouches / accessories",                        answer_style: "pass_fail",  pass_answer: true,  required: true },
      ],
    },
  ];

  var CACHE_KEY = 'lia-fp-types';

  function clone(list) {
    return list.map(function (t) {
      return {
        id: t.id || null,
        slug: t.slug,
        name: t.name,
        sort_order: t.sort_order,
        template_id: t.template_id || null,
        template_version: t.template_version || null,
        checks: (t.checks || []).map(function (c) {
          return {
            code: c.code,
            prompt: c.prompt,
            // Older cached entries predate the answer style; a plain component
            // check is the safe reading, and it is what every check but two is.
            answer_style: c.answer_style === 'yes_no' ? 'yes_no' : 'pass_fail',
            pass_answer: c.pass_answer !== false,
            required: c.required !== false,
          };
        }),
      };
    });
  }

  // The account's catalogue, if one has been synced; otherwise the built-in.
  function all() {
    try {
      var raw = root.localStorage && root.localStorage.getItem(CACHE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) return clone(parsed);
      }
    } catch (e) { /* fall through to the built-in list */ }
    return clone(BUILT_IN);
  }

  // Called after fp_type_catalog() comes down. A checklist a lead has edited
  // has to reach the phone before the tech is asked the old questions.
  function setCatalog(list) {
    if (!Array.isArray(list) || !list.length) return false;
    try {
      root.localStorage.setItem(CACHE_KEY, JSON.stringify(clone(list)));
      return true;
    } catch (e) { return false; }
  }

  function bySlug(slug) {
    var key = String(slug == null ? '' : slug).toLowerCase();
    var list = all();
    for (var i = 0; i < list.length; i++) {
      if (list[i].slug.toLowerCase() === key) return list[i];
    }
    return null;
  }

  // An item recorded before types existed carries free-text item_type, so match
  // on the display name too rather than losing its checklist.
  function byKey(key) {
    var k = String(key == null ? '' : key).trim().toLowerCase();
    if (!k) return null;
    return bySlug(k) || all().filter(function (t) {
      return t.name.toLowerCase() === k;
    })[0] || null;
  }

  // Every check at its passing answer — what the capture screen starts at, so
  // the tech only touches a check to fail it.
  function startingAnswers(type) {
    if (!type) return [];
    return type.checks.map(function (c, i) {
      return {
        ord: i,
        code: c.code,
        prompt: c.prompt,
        answer_style: c.answer_style,
        pass_answer: c.pass_answer,
        required: c.required,
        answer: c.pass_answer,
      };
    });
  }

  // The verdict, derived. Never set by the tech, and computed the same way in
  // record_fp_inspection so the two cannot disagree.
  function isPass(check) {
    return check.answer === check.pass_answer;
  }

  function overallPass(checks) {
    return (checks || []).every(function (c) {
      return c.answer != null && isPass(c);
    });
  }

  // What each button says. A yes/no question answered "Pass" would be nonsense.
  function labelFor(check, answer) {
    return check.answer_style === 'yes_no'
      ? (answer ? 'Yes' : 'No')
      : (answer ? 'Pass' : 'Fail');
  }

  var api = {
    BUILT_IN: BUILT_IN,
    all: all,
    setCatalog: setCatalog,
    bySlug: bySlug,
    byKey: byKey,
    startingAnswers: startingAnswers,
    isPass: isPass,
    overallPass: overallPass,
    labelFor: labelFor,
    CACHE_KEY: CACHE_KEY,
  };

  root.LiaFpTypes = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
