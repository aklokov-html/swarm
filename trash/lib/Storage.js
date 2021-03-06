"use strict";
var Spec = require('./Spec');
var Op = require('./Op'); Op;
var levelup = require('level');

// return values for reentrant functions
// later: reread and retry a call, done: done
var later = false, done = true;

/**
Storage is responsible for keeping operation logs and state snapshots and doing
all the log-related work. As Host and Syncables can only see the log on
op-by-op basis, all incoming ops are first filtered by a Storage
(to detect replays).

A storage only talks to its Host (which does multiplexing to local Syncables
and remote subscribers). Storage responds to every incoming subscription (.on)
with an object state or a log tail or both or neither. That response is always
a .diff. The response is followed by a reciprocal subscription (.reon).
The .deliver(spec,value) interface is the same all along the chain
(Syncable<->Host<->Storage).

A Storage relies on its underlying storage engine to actually persist and
retrieve the data. We imply an ordered key-value storage engine. All the
versioning related machinery is too much nitty-gritty to reliably replicate
it for every backend, so Storage does it all.

Operations, state snapshots and other records are stored under string keys
that form an alphanumeric total order:

                     ┌←┐  ┌──←┐
    0────────────s─────┴───s──┴──s─────>
                                   ^...    .on(bookmark) response
                          .  ^.........    .on(bookmark) response hits a backref
                                 ......    .on('') response
       . .  .. ..   ... ...............    .on(!version!vector) response ☠

    0  zero state (not stored)
    ─  operations (log)
    ┴  backreferences
    ^  (remote) log bookmark
    s  state snapshots
    >  manifest record

Note that the "hot" zone is the latest state snapshot and recent operations (aka log tail). Those group together. There is a fixed-key "manifest" record that stores the version of the last snapshot. We need to read that one quite often, contrary to historical ops that are rarely retrieved.

Record keys are base64' specifiers:

    state snapshot key:
        /Type#id!serial!timeseq+src!time+src.state   json
    op key:
        /Type#id!timeseq+src.op   something
    backreference:
        /Type#id!prev+src~ssn.~br     !lateop+src1!lateop+src2

    manifest:
        /Type#id.base     !0
        /Type#id.recent   !state!state+src!state+src
    peer bookmark (what to request):
        /Type#id.bm&source~ssn   received+sou~rce
    echo bookmark (what to send):
        /Type#id.ebm&source~ssn   echo+mi~ne

Storage engine interface is LevelUp (get, put, createReadStream), see https://github.com/Level/levelup
*/
function Storage(db, options) {
    if (!db) {
        var memdown = require('memdown');
        if (!memdown) { throw new Error('no memdown!'); }
        db = levelup(memdown);
    }
    this.id = null;
    this.host = null;
    this.db = db;
    this.pending = {
        queue: [],
        busy: false
    };
    this.options = options || {};
}
module.exports = Storage;
Storage.prototype.MAX_LOG_SIZE = 10;
Storage.prototype.isRoot = true; // may create global objects


Storage.prototype.deliver = function (op) {
    //var op = new Op(spec, value, source);
    console.log((op.source||'local')+'>'+this.id, op.toString());

    if (op.spec.op()==='diff') {
        var ops = op.unbundle();
        if (ops.length===0) {return;} // empty diff is OK
        op = ops.shift();
        this.pending.queue = this.pending.queue.concat(ops.reverse());
    }

    // ops may be processed asynchronously in parallel, except that
    // we must ensure same-id ops are sequential (to avoid data races)
    if (this.pending.busy) {
        this.pending.queue.push(op);
    } else {
        this.process(op);
    }
};


Storage.prototype.process = function (op) {

    var self = this;
    self.pending.busy = true;
    // synchronous
    var request = new Request(op, self);

    loadTail();

    function loadTail () {
        if (request.need_mark===null) {
            throw new Error('no mark provided');
        }
        var gte_key = self.id + request.prefix + request.need_mark;
        var lt_key = self.id + request.prefix + request.mark;
        self.db.createReadStream({
            gte: gte_key, // start at the mark (inclusive)
            lt: lt_key // don't read the next object's ops
        })
        .on('data', function (data){
            var key = data.key.substr(self.id.length + request.prefix.length);
            request.ops.push( {
                spec: key,
                value: data.value===' ' ? '' : data.value // leveldb issue #223
                // https://github.com/Level/levelup/issues/223
            } );
            if (-1===key.indexOf('!')) {
                request.meta[key] = data.value;
            }
        })
        .on('error', error)
        .on('end', function (err) {
            if (err) { return error(err); }
            request.mark = request.need_mark;
            request.need_mark = null;
            enter();
        });
    }

    function enter () {
        try {
            var ok = request.dispatch();
        } catch (ex) { // just in case
            console.error('error processing',op.spec+'',ex.message,ex.stack);
            request.error = ex.message;
        }
        if (request.error) {
            error(request.error);
        } else if (ok===later) {
            loadTail(); // callback loop
        } else {
            request.writes.length ? save() : send();
        }
    }

    function save () {
        var writes = request.writes.map( function(o) {
            return {
                type: o.value===undefined ? 'del' : 'put',
                key: self.id + request.prefix + o.spec,
                value: o.value || ' '
            };
        });
        self.db.batch(writes, null, send);
    }

    function send (err) {
        if (err) {  return error(err); }
        request.response.forEach(function(o) {
            self.host.deliver(o, self);
        });
        next();
    }

    function error (err) {
        err = err.toString().replace(/\n/g, ' ').substr(0,50);
        self.host.deliver( new Op(op.spec.set('.error'), err, op.source), self );
        next();
    }

    function next () {
        self.pending.busy = false;
        if (self.pending.queue.length) {
            self.process(self.pending.queue.shift());
        }
    }

};

/*
Storage.prototype.save = function (prefix, ops, callback) {
    var self = this;
    var writes = ops.map( function(o) {
        return {
            type: o.value===undefined ? 'del' : 'put',
            key: self.id + prefix + o.spec, // FIXME fast fix - db-prefix
            value: o.value || ' '
        };
    });
    self.db.batch(writes, null, callback);
};
*/

function Request ( op, store ) {
    this.options = store.options;
    this.myid = store.id; // FIXME
    this.host_id = store.host.id;
    this.spec = new Spec(op.spec);
    this.prefix = this.spec.filter('/#').toString();
    this.postfix = op.spec.toString().substr(this.prefix.length);
    this.value = op.value;
    this.source = op.source;
    this.op = this.spec.op();
    this.the_op = op;
    this.id = this.spec.id();
    this.version = this.spec.version();
    this.options = this.options;
    this.ops = [];
    this.meta = {};
    this.mark = '/';
    this.need_mark = '.';
    this.response = [];
    this.writes = [];
    this.vv = null;
    this.error = null;
}


/** We have to fetch various records from the db to process the op. A
 *  straightforward solution is to read the entire object's op log and
 *  other records, but that may be too much (like several megabytes of
 *  data just to find out that there is nothing to do).
 *  So, the main optimization is to read the tail of the log,
 *  including various meta-records. In case that is not enough, we
 *  read again, starting at a younger mark, and then *reenter* this
 *  method.
 *  Importantly, we isolate asynchronous reads here, so the actual
 *  op processing logics is synchronous (no callback hell).
 * */
Request.prototype.dispatch = function dispatch (request, callback) {
    switch (this.op) {
        // A storage is always an "uplink" so it never receives reon, reoff.
        case 'on':      return this.on();
        case 'off':     return this.off();
        case 'state':   return this.state();
        case 'diff':  return this.diff();
        case 'error':   return this.err();
        default:        return this.anyop();
    }
};

/** state snapshot; make sure it fits, change the manifest;
    can not contain unknown ops(?state o/w screw sync) */

    // The storage piggybacks on the object's state/log handling logic
    // First, it adds an op to the log tail unless the log is too long...
    // ...otherwise it sends back a subscription effectively requesting
    // the state, on state arrival zeroes the tail.

/** initializes  trivial !0 */
Request.prototype.state = function storageOn () {
    var vvspec = this.spec.filter('!');
    var vv = new Spec.Map(vvspec); // make sure the order is OK
    var tip = this.meta['.tip'];
    var recent = this.meta['.recent_state'];

    if (!tip) { // so far, stateless
        this.writes.push({spec: '.recent_state', value: vvspec});
        this.writes.push({spec: '.base_state', value: vvspec});
        this.writes.push({spec: vvspec+'.state', value: this.value});
        this.writes.push({spec: '.tip', value: vv.maxTs()}); // FIXME

        //this.response.push(this.the_op);
    } else { // stateful
        if (this.spec.author()===this.author) {
            // local state snapshot
            if (rec) {
                this.writes[recent+'.state'] = undefined;
            }
            this.writes.push({spec: '.recent_state', value: this.vvspec});
            this.writes.push({spec: vvspec+'.state', value: this.value});
        } else if (this.spec.author()==='swarm') {
            // base state overwrite
            this.error = 'not implemented yet';
        } else {
            this.error = 'have state already';
        }
    }
};

Request.prototype.err = function () {
    console.log('error reported:', this.value, this.spec.toString());
};

Request.prototype.respond = function (opname, value) { // FIXME op.reply()
    var op = opname ?
        new Op(this.spec.set(opname), value, this.myid) :
        new Op(this.spec, this.value, this.source); // keep the orig src
    this.response.push(op);
};

/* reentrant */
Request.prototype.patch = function () {
    var self = this;
    var tip = this.meta['.tip'];
    var recent = this.meta['.recent_state'];
    var recent_vv = new Spec.Map(recent);
    var base = this.value;
    var tail = null, m;
    if (!recent) {
        // Storage has no state => can provide no response.
        // This error is intercepted by Host; the request is resubmitted
        // once some state arrives (reentrancy trick No2).
        //this.respond('.error', 'no data');   .reon '' is enough
        // this is a "normal error", the response is not aborted, .reon is sent
    } else if (base==='') {
        // The peer has nothing. We should send the recentmost state we have
        // plus any ops that came later.
        if (!this.markLoaded(recent)) { return later; }
        if (!this.backrefsLoaded()) { return later; }
        var state;
        this.ops.some(function(o){
            return o.spec.indexOf('.state')!==-1 &&
                new Spec(o.spec).filter('!').toString()==recent &&
                (state = o);
        });
        tail = this.ops.filter( function (op) {
            var s = new Spec(op.spec);
            if (s.pattern()!=='!.') { return false; }
            var version = s.version();
            return !recent_vv.covers(version);
            // return backrefs.underlies(version);
        });
        tail.unshift(state);
    } else if (base=='!~') {
        // The peer will not accept any ops from us, so we only need to
        // read our replica version v (to send back a .reon)
    } else if (base==='-') {
        // we are supposed to have an echo bookmark
        var echo = this.meta['.eb&'+this.spec.source()];
        "see the next case";
    } else if (m=base.match(Spec.reTokExt)) { // this.tail for noop check
        // The peer has a bookmark that points to a position in our arrival
        // order. Thus, we may cheaply fetch later ops and send them back
        // TODO: filters, check for log cleaning
        if (!this.markLoaded(base)) { return later; }
        if (!this.backrefsLoaded()) { return later; }
        tail = this.ops.filter(function(op){
            var s = op.spec;
            return s.charAt(0)==='!' && s.indexOf('.state')===-1;
        });
    } else if (m=base.match(Spec.reQTokExt)) {
        // The most general (and most avoided) case is a version vector;
        // we'll have to make a proper patch; We send out some op
        // even if unnecessary to provide a peer with a bookmark.
        // This also includes !0 (peer's replica is in the default state)
        var base_vv = new Spec.Map(base);
        if (recent_vv.coversAll(base)) {
            if (!this.markLoaded('!'+recent_vv.maxTs())) { return later; } // FIXME
        } else {
            if (!this.markLoaded('!0')) { return later; } // TODO p2p sync
        }
        if (!this.backrefsLoaded()) { return later; }
        tail = this.ops.filter(function(op){
            var spec = new Spec(op.spec);  // TODO use Op
            var version = spec.version();
            return version && !base_vv.covers(version) &&
                spec.op()!=='state';
        });
    } else {
        this.error = "base expression not understood";
    }
    if (tail) {
        var bundle = tail.map( function(op) {
            return '\t' + op.spec + '\t' + op.value + '\n';
        });
        this.respond('.diff', bundle.join(''));
    }
    return done;
};

Request.prototype.deriveVersionVector = function () {
    var recent = this.meta['.recent_state'];
    if (!recent) {
        this.vv = new Spec.Map();
        return done;
    }
    var max = recent.match(Spec.reQTokExt).sort().pop();
    if (!this.markLoaded(max)) { return later; }
    var vv = new Spec.Map(recent);
    this.ops.forEach(function(op){
        var spec = new Spec(op.spec);
        vv.add(spec.version());
        if (spec.op()==='br') {
            vv.add(op.value);
        }
    });
    this.vv = vv.toString();
    return done;
};

// .preon is a logix-to-storage .on; it sends back a patch, then
// sends an .on for the specified uplink
//var ok = this.patch();
//if (ok===later) { return later; }
// We likely did not sync that object to this client before,
// hence we have no log bookmark.
// The only way to go is to produce a version vector.

/** Accept a subscription for an object: open it, send back a patch
  * and a reciprocal subscription.
  */
Request.prototype.on = function () {
    // send back a diff
    if (this.value!=='~') {
        var ok = this.patch();
        if (ok===later) { return later; }
    }
    var origin = this.the_op.origin();
    if (this.host_id===origin) { // reon
        return done;
    }
    // send back a reciprocal .on
    var base;
    if (!this.meta['.base_state']) {
        // we have no state at all
        base = '';
    } else if (this.value==='') {
        // In case the client retrieves that object for the first time,
        // we may use a "self-fulfilling" bookmark which is our tip.
        base = this.meta['.tip'];
    } else if (this.meta['.bm&'+origin]) {// got a bookmark
        base = this.meta['.bm&'+origin];
    } else if (this.value!=='~' && Spec.reTokExt.test(this.value)) {
        // In case the client provides a bookmark, it already knows
        // the base from the echo bookmark.
        base = '';
    } else {
        // In other cases, we send the version vector as a last resort.
        if (this.deriveVersionVector()===later) { return later; }
        base = this.vv.toString();
    }
    this.respond('.on', base);
    return done;
};


Request.prototype.anyop = function storageOnOp () {
    // It was previously planned to cache tips for open objects. But,
    // assuming tails of open objects are "hot", the read is supposed
    // to be cheap. If this turns a bottleneck, may always add some
    // caching in dispatch()
    var tip = this.meta['.tip'];

    // TODO if tips are cached in RAM, no db read in 9x% cases (write only)

    if (tip===undefined) { // '' is OK (open, empty)
        this.error = 'no such object';
        return done;
    }

    if (tip===this.version) { // fast-track echo
        this.writes['.ebm&'+this.source] = tip; // not spec.source()!!!
    } else if (tip>this.version) { // arrival order <> total order mismatch
        // have to check the db: whether it is an echo or a reorder
        if (!this.markLoaded('!'+this.version)) { return later; }
        var tok = new Spec(this.version,'!').token('!');
        for(var i=0; i<this.ops.length; i++) {
            var op = this.ops[i];
            var v = new Spec(op.spec).token('!');
            if (v && v.ext===tok.ext) {
                if (v.bare>tok.bare) {
                    // There is a younger operation from the same source=>
                    // causal order is violated, can't write this.
                    this.error = 'op is out of order';
                    return done;
                } else if (v.bare===tok.bare) { // replay/echo
                    return done; // FIXME bookmark
                }
            }
        }
        // We assume that ops mostly come in order. Every reorder
        // event is recorded as a backreference, so we can correctly
        // recover the arrival order later.
        this.writes.push({ spec: this.postfix, value: this.value});
        var brkey = '!'+tip + '.~br';
        var backref = this.meta[brkey] || '';
        var brvv = new Spec.Map(backref);
        if (!brvv.has(this.spec.source())) {
            // we preserve the earliest reordered op
            // for each source
            brvv.add(this.version);
            this.writes.push({ spec: brkey, value: brvv.toString() });
        }
        // Storage returns every new op it gets; Host routes them
        // to the logics and elsewhere
        this.respond();
    } else { // a new in-order op
        this.writes.push({ spec: '.tip', value: this.version });
        this.writes.push({ spec: this.postfix, value: this.value });
        this.respond();
    }

    if (this.options.bookmarking) {
        // remember the last op received from each source, so we
        // can ask it to replay from that exact place
        this.writes['.bm&'+this.source] = this.version;
    }
    return done;
};


Request.prototype.off = function () {
    // we do nothing anyway
    return done;
};


Request.prototype.backrefsLoaded = function () {
    var backrefs = '';
    this.ops.forEach(function(op){
         if (op.spec.indexOf('.~br')!==-1) {
             backrefs += op.value;
         }
    });
    if (!backrefs) return true;
    var br = backrefs.match(Spec.reQTokExt).sort();
    var oldest = br.pop();
    return this.markLoaded(oldest);
};


Request.prototype.markLoaded = function (mark) {
    if (!mark) {
        throw new Error('attempted inf cycle :)');
    }
    if (this.mark<=mark) {
        return done;
    } else {
        this.need_mark = mark;
        return later;
    }
};

/**
 *  A complete op log may be enormous (imagine a document where
 *  every symbol is an op). Hence, we go to great lengths not to
 *  scan he entire log. In most of the cases, responding to an object
 *  subscription requires just a *tail* read.
 *  The worst case of a full scan can also be seen as an extreme case
 *  of a tail read. Log head/middle reads are potentially possible
 *  (old version recovery), but the case is special.
 *  So, all the heavylifting/shoveling happens here.
 *  A "tail" is defined relative to the operation arrival order,
 *  i.e. all the operations that arrived after the reference op
 *  (aka bookmark).
 */
Storage.prototype.readLogTail = function (request, callback) {
    // we return everything we have found + some calculated results
    var ret = {
        // all the .state snapshots we encountered
        states: [],
        // all the regular ops as {spec,val} objects
        ops: [],
        // max op id (lexicographically)
        tip: '',
        // version vector for all the ops (does not include state
        // snapshot vvs)
        vv: new Spec.Map(),
        backrefs: []
    };

    var prefix = spec.filter('/#').toString();
    db.createReadStream({
        gte: prefix + '!' + bookmark, // start at the bookmark (inclusive)
        lt: prefix + '/' // don't read the next object's ops
    })
    .on('data', tailOpRead)
    .on('end', tailReadComplete);

    function tailOpRead (data) {
        // for a Storage, state/op values are opaque strings
        switch (s.op()) {
            case 'state': ret.states.push(op);
                          break;
            case 'br':    ret.backrefs.push(op);
                          break;
            default:      ret.ops.push(op);
                          ret.vv.add(spec.filter('!'));
                          break;
        }
    }

    function tailReadComplete () {
        // thanks God, backreferences don't act recursively
        var bottom = new Spec.Map();
        ret.backrefs.forEach(function(br){
            var map = new Spec.Map(br.value);
            bottom.lowerUnion(map);
        });
        var oldest = map.minTs();

        // The tail read is not entirely complete in case we encountered
        // some backreferences. (Arrival order matches total
        // alphanumeric order in most of the cases, but not always).
        if (oldest && oldest<bookmark) {
            // Go back and read those reordered ops.
            db.createReadStream({
                gte: ti + oldest,
                lt: ti + bookmark
            })
            .on('data', brOpRead)
            .on('end', respond);
        } else {
            respond();
        }
    }

    function brOpRead (data) {
        var spec = new Spec(key).filter('!.');
        if (spec.op() in {state:1, br:1}) { return; }
        var version = s.filter('!').toString();
        if (backrefd.has(version) && !backrefd.covers(version)) {
            var op = {spec:spec.toString(), value:data.value};
            ret.ops.push(op);
            ret.vv.add(version);
        }
    }

    function respond () {
        ret.ops.sort(function(a,b){ return a.spec < b.spec; });
        // a *tip* is the max op id known so far
        ret.tip = ret.vv.maxTs();
        // state vvs also count; we may have one state and no ops,
        // the tip will be equal to the younger op mentioned in
        // the state vv ('0' for a default state)
        ret.states.every(function(state){
            var map = new Spec.Map(new Spec(state.spec).filter('!'));
            var max = map.maxTs();
            if (max>tip) { tip=max; }
        });
        callback(ret);
    }

};





    // The `base` argument conveys us the peer's replica state.
    // Thus, defines the contents of the patch we wend back.
    // In the general case, `base` is a version vector:
    //    `!time1+src1!time2+src2`
    // In case the peer replica is in the default state, `base`
    // collapses to `!0`. In case we have no permission to write,
    // `base` is `!~` ("no patches, please"). If the peer has no
    // state at all, then `base` is an empty string.
    // In case the peer just created and initialized the object,
    // the base (version) will be equal to the object id.
    //
    // A vector may be substituted for a *log reference*, like
    // `time3+src3`. A log reference points to a certain position
    // in our own local operation log (assuming we record ops in
    // their *arrival* order). It is a very convenient shortcut,
    // as it collapses the vector to a single value. The cost
    // of that convenience is that we have to remember the latest
    // op we received from each respective source.
    //
    // Another important optimization is descended states. That
    // one is mostly useful for peer-to-peer syncing and that one
    // is too much math to cover it here.
    //
    // In general, the `base` parameter is an optimization.
    // It lets us send a diff (log tail) instead of a full log.


    //  ##################  ON / REON / PREON FLOWCHART  ####################
    //
    //  .on related code never writes to db. Great effort is spent to go by
    //  the fast path (one range read). Unless the op is .preon, the object
    //  becomes "open" as a result (its max op id gets into this.tip[id];
    //  tip is '' for stateless/open and undefined for "closed" objects)
    //
    //                            ↓
    //      ╔════base=~bookmark═══╡
    //      ↓                     ├────────────────.preon───────────────────┐
    //      ║                read manifest                                  │
    //      ║                     │                                         │
    //      ║             ┌───────┴─────┬──────────────┐                    │
    // base is bookmark   │             │              │                    │
    // or "0" (echo bm)  base=='!~'   base==''   base=='!version!vector'    │
    //      ║             │             │              │                    │
    // "dumb read"   read the tail  read recent  tail read starting         │
    //  starting     to get the     state and    either at the recent state │
    //  at the       tip unless     later ops    or at !0 (full scan), ☠    │
    //  bookmark     it is already      │        filtered by the base vv    │
    //      ║           known           │        (follow backrefs)          │
    //      ║             │             │              │                    │
    //      ║             │             │              │                    │
    //  the tip is found by the tail read, so the object is now "open"      │
    //      ║             └─────┬───────┴──────────────┘                    │
    //      ║                   ├─────────────────── ← ─────────────────────┘
    //      ║                   ↓
    // send .reon 0             │                            ## LEGEND ##
    //      ║         do we have a bookmark?
    //      ║         (or can we impose it?)                 │ code path
    // (the peer      ┌─────────┴────────┐☠                  ║ fast path
    // has an echo   if yes         if not send              ☠ worst case
    // bookmark and  send           .reon !full!ver!vec      ↓ direction
    // knows what    .reon bm       (recent vv + *tail* vv)
    // to send)       └─────────┬────────┘
    //      ╚═══════════════════╡
    //                          ↓
    //
    //  #####################################################################



    // TESTS:
    // 2. know nothing => ''
    // 3. no changes => {}
    // 4. log tail (patch) => [ spec: val: ]
    // 5. state
    // 6. state+tail





// Secondary backend note
// In case third parties may write to the backend, the developer
// has to figure some way to retrofit those changes.


Storage.prototype.close = function (callback) {
    self.db.close(function(err){
        callback(err);
    });
};
