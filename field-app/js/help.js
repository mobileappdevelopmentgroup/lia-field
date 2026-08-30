// Lia Field — help.js
//
// The manual, built into the app.
//
// Written for a tech standing on a job with one bar of signal and a customer
// waiting, not for someone reading at a desk. That drives everything about it:
//
//   · It is BUNDLED, not fetched. Help you cannot open in a basement is not
//     help. Every word and every picture ships with the app.
//   · It answers "what do I press", not "what is the data model". Where a
//     concept has to be explained it is explained in one sentence, in the
//     middle of the steps that need it.
//   · The pictures are real screenshots of this app, captured by
//     tools/capture-help-shots.mjs, with the thing you are meant to press
//     already ringed. See that file for why they are generated rather than
//     drawn: a hand-placed callout drifts the moment a button moves, and a
//     manual that points at the wrong button is worse than none.
//   · Every topic ends with a way to ask a human, because documentation that
//     dead-ends is how a tech learns to stop looking.
//
// Part of the field app. Classic script — see the note in storage.js.

(function (root) {
  'use strict';

  // A picture that has not been captured yet must not leave a broken frame in
  // the middle of a step. Missing images are hidden on error; the words alone
  // still work.
  function shot(name, caption) {
    return { type: 'shot', src: './help/img/' + name + '.png', caption: caption };
  }
  function p(text) { return { type: 'p', text: text }; }
  function steps(list) { return { type: 'steps', list: list }; }
  function note(text) { return { type: 'note', text: text }; }
  // Reserved for the things that cost real money or real safety if got wrong.
  // Used sparingly — a page of warnings is a page nobody reads.
  function warn(text) { return { type: 'warn', text: text }; }

  var TOPICS = [
    // ── Start here ──────────────────────────────────────────────────────────
    {
      id: 'start',
      group: 'Start here',
      title: 'What this app is for',
      blurb: 'The two-minute version.',
      body: [
        p('Lia Field records inspections on your phone so you never have to write ' +
          'them twice. You collect on the phone; the office gets them automatically.'),
        p('It does two kinds of work, and you pick which when you start a job:'),
        steps([
          '<strong>Ladders</strong> — serial, brand, type, length, and the parts a ladder needs.',
          '<strong>Fall protection</strong> — harnesses, lanyards, slings and the rest, ' +
          'with the pass/fail checks for that kind of item.',
        ]),
        p('Everything you enter is saved on the phone the instant you enter it. ' +
          'You do not need signal. When the phone next finds wifi or data it sends ' +
          'what it has, on its own, without you doing anything.'),
        note('If you remember one thing: the app never loses work because you were ' +
             'out of range. Keep working. It catches up.'),
      ],
    },
    {
      id: 'signin',
      group: 'Start here',
      title: 'Signing in and the first download',
      blurb: 'Do this once, on wifi, before your first job.',
      body: [
        p('Sign in with the email and password your company set up for you.'),
        shot('auth', 'The sign-in screen.'),
        p('The first time you sign in, the app downloads your company\'s equipment ' +
          'list. This is what makes a tag or a barcode bring up last year\'s record ' +
          'instead of a blank form.'),
        shot('sync', 'The one-time download. It shows progress so you can see it working.'),
        warn('Do this on wifi, before you drive out. Without the equipment list, ' +
             'every item you scan will look brand new — and you will be typing all ' +
             'day for records that already exist.'),
        p('After that first download the app works with no signal at all. It ' +
          'refreshes itself quietly whenever you have a connection.'),
      ],
    },
    {
      id: 'jobs',
      group: 'Start here',
      title: 'Starting a job',
      blurb: 'One job per work order.',
      body: [
        steps([
          'Tap <strong>+ New Job</strong> on the main screen.',
          'Choose <strong>Ladders</strong> or <strong>Fall protection</strong>.',
          'Give it a name you will recognise and enter the work order number.',
        ]),
        shot('jobs', 'The job list. Tap a job to carry on with it.'),
        p('Jobs stay on the phone until you delete them, so you can stop halfway ' +
          'through, go to lunch, and pick it back up.'),
        note('The work order number is what ties your collection to the office\'s ' +
             'paperwork. Get it right and everything downstream matches up.'),
      ],
    },

    {
      // No screenshot on purpose: this list only appears when a lead has
      // actually assigned something, so it cannot be captured from a clean app
      // the way the other screens can. Words alone, rather than a picture of an
      // empty list that would teach the wrong thing.
      id: 'assigned',
      group: 'Start here',
      title: 'Jobs your lead sends you',
      blurb: 'When the work order comes from the office instead of from you.',
      body: [
        p('If your lead plans the day in the office, the jobs he gives you appear ' +
          'at the top of your job list, above the ones you made yourself. They are ' +
          'marked <strong>You</strong> if he sent it to you, or <strong>Team</strong> ' +
          'if it went to everybody.'),
        steps([
          'Tap <strong>Start</strong> on the job to begin it. Tap <strong>Open</strong> ' +
          'to carry on with one you already started.',
          'Collect exactly as you normally would.',
        ]),
        p('The work order number on these jobs comes from your lead and cannot be ' +
          'changed. That is deliberate: the number is how the office matches your ' +
          'day\'s work to the paperwork, and one typed slightly differently is a ' +
          'day nobody can find.'),
        p('If your lead has turned it on, a <strong>Team</strong> button shows what ' +
          'the others on the job have already recorded. It is read-only — you can ' +
          'see it, you cannot change it. If there is no Team button, he has not ' +
          'turned it on.'),
        note('The list is refreshed whenever you have signal. With no signal it ' +
             'shows the last one it got, and tells you how old that is. You can ' +
             'still start any job, assigned or not — nothing here stops you working.'),
        p('When your lead marks a job complete it stays on your phone for a couple ' +
          'of days, marked closed, so you can see it landed.'),
      ],
    },

    // ── Tags ────────────────────────────────────────────────────────────────
    {
      id: 'tag-write',
      group: 'Tags',
      title: 'Putting one of our tags on an item',
      blurb: 'What gets written, and what to print on the tag face.',
      body: [
        p('Our own tags carry two things: a link to the item\'s certificate, and ' +
          'the item\'s serial number. You also write the tag\'s own code on the ' +
          'label — that is the number printed on the front of the tag, not the ' +
          'serial stamped on the harness. They are different, and both matter.'),
        steps([
          'Bring up the item — scan it, tap its old tag, or type the serial.',
          'Tap <strong>Write tag</strong> on the item\'s record.',
          'Type the code printed on the new tag into <strong>Label</strong>.',
          'Check the preview, then hold the phone against the tag.',
        ]),
        p('After that, the item can be found <strong>five</strong> ways: the ' +
          'serial on the equipment, the label on the tag, tapping the tag, the ' +
          'certificate code, or opening the link. Whichever one you or the ' +
          'customer happens to have, it brings up the same record.'),
        note('Writing works with no signal. The tag is correct the moment it is ' +
             'written, and the office finds out when your phone next has service ' +
             '— same as an inspection.'),
        warn('If the app says the label is already on another item, stop and ' +
             'check. Two items sharing one label means somebody gets handed the ' +
             'wrong certificate.'),
        p('Replacing a tag is fine — the app will say it is a replacement. ' +
          'Take the old tag off the equipment when you do, or there will be two ' +
          'tags on one harness saying different things.'),
      ],
    },

    // ── Fall protection ─────────────────────────────────────────────────────
    {
      id: 'fp-identify',
      group: 'Fall protection',
      title: 'Getting an item in hand',
      blurb: 'Four ways, and they all end up in the same place.',
      body: [
        p('Before you can inspect something the app has to know which item it is. ' +
          'There are four ways in, and you use whichever is easiest with the item ' +
          'in your hand:'),
        shot('fp-input', 'Tap, Scan, Type, or New — pick whichever suits the item.'),
        steps([
          '<strong>Tap</strong> — hold the phone against the item\'s tag. Fastest by far.',
          '<strong>Scan</strong> — point the camera at a barcode.',
          '<strong>Type</strong> — key the serial in by hand.',
          '<strong>New</strong> — an item with nothing on it at all.',
        ]),
        p('If the app recognises the item it shows you what it already knows: ' +
          'manufacturer, model, when it was last inspected. Check it against what ' +
          'is in your hand, and if something is wrong tap <strong>Edit</strong>.'),
        shot('fp-record', 'A recognised item. Everything already filled in.'),
        p('If it does not recognise it, that is normal — it means this is the first ' +
          'time anyone has inspected it. Fill it in once and it comes up complete ' +
          'next time.'),
      ],
    },
    {
      id: 'fp-checks',
      group: 'Fall protection',
      title: 'Doing the checks',
      blurb: 'Everything starts at passing. You only touch what fails.',
      body: [
        p('The checks you are asked come from the <strong>equipment type</strong> — ' +
          'a harness gets harness checks, a sling gets sling checks. That is why ' +
          'the type has to be set before there are any questions to answer.'),
        shot('fp-checks', 'The checklist. Every answer already sits at passing.'),
        p('Every check starts on its passing answer. If the item is good you do not ' +
          'have to touch any of them — just tap <strong>Pass &amp; Next Item</strong>.'),
        warn('One question is backwards on purpose: <em>"Has the impact indicator ' +
             'been activated?"</em> On that one, <strong>Yes means the item FAILS</strong>. ' +
             'An activated indicator means the gear has taken a fall. The app knows ' +
             'this and scores it correctly — but read the question, do not skim it.'),
        p('Tap any check to fail it. The moment one check fails, the whole item ' +
          'fails, and the button at the bottom changes to a removal.'),
      ],
    },
    {
      id: 'fp-fail',
      group: 'Fall protection',
      title: 'Taking an item out of service',
      blurb: 'A photo is required. The reason is not typed.',
      body: [
        p('When an item fails, the app asks for a photo before it will record it.'),
        shot('fp-condemn', 'Removal from service. The photo is the gate.'),
        steps([
          'Tap <strong>Add photo</strong> and take a picture of the defect.',
          'Add a note if there is something the picture does not show. Optional.',
          'Tap <strong>Confirm Removal</strong>.',
        ]),
        p('You do not type a reason. The check you failed <em>is</em> the reason, and ' +
          'the certificate is written from it — so what the paperwork says always ' +
          'matches what you actually found.'),
        note('Photos stay on the phone until you are back on wifi, then upload with ' +
             'everything else. They are kept for two years.'),
      ],
    },
    {
      id: 'fp-batch',
      group: 'Fall protection',
      title: 'Tap-through: working a whole rack',
      blurb: 'For when you have already inspected everything by hand.',
      body: [
        p('The other way techs work: go down the rack inspecting everything by eye ' +
          'first, then walk it again tapping each item. Every tap records a pass.'),
        shot('fp-batch', 'A tap-through run. The count goes up with every tap.'),
        warn('Only use this when you have <strong>actually inspected</strong> the ' +
             'items. Every tap puts a passing inspection on record with your name ' +
             'on it. The phone is the recorder here, not the inspector.'),
        p('A run stops itself the moment it cannot honestly record a pass:'),
        steps([
          'The tag matches nothing we know about.',
          'The item has no equipment type, so there is no checklist to pass.',
          'You tap <strong>Fail last</strong>.',
        ]),
        p('When it stops, it hands you that one item on the ordinary screen. Deal ' +
          'with it, and the run picks straight back up where it left off.'),
        p('<strong>Undo last</strong> takes the last tap back off the record ' +
          'completely — including out of the upload queue, so nothing can reach ' +
          'the office claiming it passed.'),
        note('On iPhone, the reader closes itself every so often — that is Apple, ' +
             'not the app. Press <strong>Keep tapping</strong> to open it again. ' +
             'Neither phone reads tags with the screen off.'),
      ],
    },

    // ── Tags ────────────────────────────────────────────────────────────────
    {
      id: 'tags',
      group: 'Tags',
      title: 'Tags that are not ours',
      blurb: 'What to do when a tag brings up a web link.',
      body: [
        p('Two kinds of tag turn up on a rack.'),
        p('<strong>Ours</strong> carry the serial and a link to the certificate. ' +
          'They just work — tap and the record comes up.'),
        p('<strong>The customer\'s existing tags</strong> were put on by whoever ' +
          'supplied the gear. They have a serial printed on the outside and, ' +
          'inside, a link into somebody else\'s system. Nothing on them matches ' +
          'our records, so tapping one opens this instead:'),
        shot('fp-link', 'A tag we do not know. The link is shown first, because it ' +
                        'is the one thing you can act on by yourself.'),
        p('The app tries to read what is behind the link. Often it cannot — most of ' +
          'those systems do not allow it — and that is not a fault, it is normal. ' +
          'Either way you get three choices:'),
        steps([
          '<strong>Inspect this item</strong> — carry on and inspect it now. The ' +
          'link is saved on the record either way.',
          '<strong>Save the link only</strong> — you are not doing this one now, ' +
          'but the tag is remembered so the next tap on it recognises it.',
          '<strong>Skip this one</strong> — set it aside entirely.',
        ]),
        warn('If the app does manage to read the link, what it shows you is marked ' +
             '<em>claimed — unverified</em>. That is somebody else\'s paperwork, not ' +
             'ours. It never counts as an inspection and it never goes on a ' +
             'certificate. Only what <strong>you</strong> record does.'),
        note('The app will never put a tag\'s internal ID into the serial box. If ' +
             'the serial is blank, type what is printed on the item.'),
      ],
    },

    // ── Ladders ─────────────────────────────────────────────────────────────
    {
      id: 'ladders',
      group: 'Ladders',
      title: 'Recording a ladder',
      blurb: 'Serial, details, parts.',
      body: [
        p('Scan or type the serial. If the ladder is already known, the brand, type ' +
          'and length come up filled in — check them and move on.'),
        shot('ladder-entry', 'Ladder entry. Scan the plate, or type it.'),
        steps([
          'Serial number — scan the plate or type it.',
          'Brand, type and length.',
          'Location ID, if the site uses them.',
          'Add the parts it needs.',
        ]),
        p('Parts are added from the parts library so the names always match what ' +
          'the office expects. Tap a part twice to make it a quantity of two.'),
        note('Anything you are unsure about goes in the description. It comes ' +
             'through to the office with the rest.'),
      ],
    },

    // ── Everything else ─────────────────────────────────────────────────────
    {
      id: 'offline',
      group: 'Day to day',
      title: 'Working with no signal',
      blurb: 'The short answer: just keep working.',
      body: [
        p('Everything you record is written to the phone immediately. Signal has ' +
          'nothing to do with it.'),
        p('When something is waiting to be sent you will see a count on screen. ' +
          'That count is not a warning — it is the app telling you it knows about ' +
          'the backlog and is holding it safely.'),
        shot('pending', 'Items waiting to upload. Nothing is lost.'),
        p('The moment the phone gets wifi or data it sends them, in order, without ' +
          'you doing anything. You can watch the count go down.'),
        warn('Do not delete a job because it says items are waiting. That is the ' +
             'only copy until it has uploaded.'),
        p('If something will not go through after a few tries the app says so ' +
          'rather than hiding it. That is worth reporting — see ' +
          '<em>Getting help</em>.'),
      ],
    },
    {
      id: 'settings',
      group: 'Day to day',
      title: 'Settings and custom fields',
      blurb: 'Theme, sounds, and your own columns.',
      body: [
        p('The gear icon on a job opens settings.'),
        steps([
          '<strong>Display</strong> — light or dark. Dark is easier in a truck at night.',
          '<strong>Sounds</strong> — what you hear on a successful scan and on a save. ' +
          'Set them to something you can tell apart without looking.',
          '<strong>Custom fields</strong> — extra columns on every ladder entry, for ' +
          'anything your company tracks that the standard form does not.',
        ]),
        p('<strong>Refresh equipment list</strong> pulls the catalogue down again. ' +
          'Worth doing if an item you know exists is coming up as new.'),
      ],
    },
    {
      id: 'trouble',
      group: 'Day to day',
      title: 'When something is not right',
      blurb: 'The handful of things worth trying first.',
      body: [
        p('<strong>A tag will not read.</strong> Hold the back of the phone flat ' +
          'against the tag and keep it there for a couple of seconds — the antenna ' +
          'is usually near the top on Android and near the camera on iPhone. The ' +
          'screen must be on and the app must be open; neither phone reads tags ' +
          'with the screen off.'),
        p('<strong>An item I know we have comes up as new.</strong> The catalogue on ' +
          'the phone is probably behind. Open settings and tap <strong>Refresh ' +
          'equipment list</strong> while you have signal.'),
        p('<strong>The scanner will not focus.</strong> Give it more light and hold ' +
          'it further back than feels right — about a hand\'s width. If it still ' +
          'will not, type the serial; never guess it.'),
        p('<strong>Something is waiting to upload and not going.</strong> Check you ' +
          'actually have data, then open and close the app. If it still will not, ' +
          'report it — and do not delete the job.'),
        p('<strong>I recorded the wrong thing.</strong> On a tap-through run, ' +
          '<strong>Undo last</strong> removes it completely. If it has already ' +
          'uploaded, report it with the serial and the date and it can be ' +
          'corrected at the office.'),
        note('None of these working? Send a ticket. It takes a few seconds and it ' +
             'goes straight to the person who can fix it.'),
      ],
    },
  ];

  // ── Sample workflows ──────────────────────────────────────────────────────
  // A tech who has read every topic still does not know what a DAY looks like.
  // These are the two shapes of day, start to finish, with no concepts in them
  // that the topics have not already covered.
  var WORKFLOWS = [
    {
      id: 'wf-fp-rack',
      title: 'A rack of fall protection, start to finish',
      when: 'The everyday one. Twenty to a hundred items on a wall.',
      list: [
        'Before you leave: open the app on wifi and let it finish downloading.',
        'On site, tap <strong>+ New Job</strong> → <strong>Fall protection</strong>. ' +
        'Name it after the site and enter the work order number.',
        'Take the first item down. Tap it against the phone.',
        'The record comes up. Check it matches what is in your hand.',
        'Look the item over. If it is good, tap <strong>Pass &amp; Next Item</strong>.',
        'If something is wrong, tap the check that is wrong, photograph it, and ' +
        'confirm the removal.',
        'Repeat. The item list at the bottom grows as you go.',
        'When the rack is done, the job holds everything. Get back in range and ' +
        'watch the waiting count drop to nothing.',
      ],
    },
    {
      id: 'wf-fp-batch',
      title: 'A rack you have already inspected by hand',
      when: 'Faster, but only honest if you really did inspect them first.',
      list: [
        'Inspect the whole rack by eye first. Set aside anything that fails.',
        'Start the job, then tap <strong>Tap through a rack</strong>.',
        'Walk the rack tapping each item. Every tap buzzes and counts.',
        'When it stops on one, deal with that item on screen and carry on.',
        'The ones you set aside: do those individually, with photos.',
        'Tap <strong>Done</strong> when the rack is finished.',
      ],
    },
    {
      id: 'wf-unknown-tag',
      title: 'A tag that brings up a web link',
      when: 'Customer gear that came tagged by somebody else.',
      list: [
        'Tap the item. The app says it is not on file and shows you the link.',
        'If it managed to read the link it shows what that system claims. Treat ' +
        'that as a hint, not as fact — it is marked unverified for a reason.',
        'Tap <strong>Inspect this item</strong>.',
        'Type the serial printed on the item, and pick the equipment type. ' +
        'The type is what decides the checks, so it must be right.',
        'Inspect and record it as normal.',
        'Next time anyone taps that tag, it will come straight up.',
      ],
    },
    {
      id: 'wf-ladders',
      title: 'A ladder job',
      when: 'Ladders and the parts they need.',
      list: [
        'Tap <strong>+ New Job</strong> → <strong>Ladders</strong>, and enter the ' +
        'work order number.',
        'Scan the serial plate, or type the number.',
        'Fill in brand, type, length and location.',
        'Add the parts from the library. Tap a part again for quantity two.',
        'Tap <strong>Add Ladder</strong> and move to the next one.',
        'At the end, export or let it upload — whichever your office asked for.',
      ],
    },
  ];

  // ── Search ────────────────────────────────────────────────────────────────
  // A tech looking for help types the word he has in his head — "tag", "photo",
  // "wifi" — not the title of a topic. So the whole body is searched, and
  // matches are ranked with the title first.
  function plain(node) {
    if (!node) return '';
    if (node.type === 'steps') return node.list.join(' ');
    return String(node.text || node.caption || '');
  }

  function haystack(topic) {
    return (topic.title + ' ' + topic.blurb + ' ' +
            topic.body.map(plain).join(' ')).replace(/<[^>]*>/g, ' ').toLowerCase();
  }

  function search(query) {
    var q = String(query || '').trim().toLowerCase();
    if (!q) return TOPICS.slice();
    var terms = q.split(/\s+/);
    return TOPICS.map(function (t) {
      var hay = haystack(t);
      var title = t.title.toLowerCase();
      var score = 0;
      terms.forEach(function (term) {
        if (title.indexOf(term) >= 0) score += 10;
        if (hay.indexOf(term) >= 0) score += 1;
      });
      return { topic: t, score: score };
    }).filter(function (r) { return r.score > 0; })
      .sort(function (a, b) { return b.score - a.score; })
      .map(function (r) { return r.topic; });
  }

  function byId(id) {
    return TOPICS.filter(function (t) { return t.id === id; })[0] || null;
  }

  function groups() {
    var seen = [];
    TOPICS.forEach(function (t) { if (seen.indexOf(t.group) < 0) seen.push(t.group); });
    return seen;
  }

  var api = {
    topics: function () { return TOPICS.slice(); },
    workflows: function () { return WORKFLOWS.slice(); },
    groups: groups,
    byId: byId,
    search: search,
  };

  root.LiaHelp = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
