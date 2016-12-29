'use strict';

var EventEmitter = require('events');

class ModernEventEmitter extends EventEmitter {


    addListener(type, listener, self) {
        if (typeof listener == "function" && self) listener.ctx = self;
        return _addListener(this, type, listener, false);
    };
    
    prependListener(type, listener, self) {
        if (typeof listener == "function" && self) listener.ctx = self;
        return _addListener(this, type, listener, true);
    };


    emitNone (handler, isFn, self) {
        if (isFn) {
            if (handler.ctx) self = handler.ctx;
            handler.call(self);
        } else {
            var len = handler.length;
            var listeners = arrayClone(handler, len);
            for (var i = 0; i < len; ++i) {
                if (listeners[i].ctx) self = listeners[i].ctx;
                if (!listeners[i].call(self)) break;
            }
        }
    }
    
    emitOne(handler, isFn, self, arg1) {
        if (isFn) {
            if (handler.ctx) self = handler.ctx;
            handler.call(self, arg1);
        } else {
            var len = handler.length;
            var listeners = arrayClone(handler, len);
            for (var i = 0; i < len; ++i) {
                if (listeners[i].ctx) self = listeners[i].ctx;
                if (!listeners[i].call(self, arg1)) break;
            }
        }
    }
    
    emitTwo(handler, isFn, self, arg1, arg2) {
        if (isFn) {
            if (handler.ctx) self = handler.ctx;
            handler.call(self, arg1, arg2);
        } else {
            var len = handler.length;
            var listeners = arrayClone(handler, len);
            for (var i = 0; i < len; ++i) {
                if (listeners[i].ctx) self = listeners[i].ctx;
                if (!listeners[i].call(self, arg1, arg2)) break;
            }
        }
    }
    
    emitThree(handler, isFn, self, arg1, arg2, arg3) {
        if (isFn) {
            if (handler.ctx) self = handler.ctx;
            handler.call(self, arg1, arg2, arg3);
        } else {
            var len = handler.length;
            var listeners = arrayClone(handler, len);
            for (var i = 0; i < len; ++i) {
                if (listeners[i].ctx) self = listeners[i].ctx;
                if (!listeners[i].call(self, arg1, arg2, arg3)) break;
            }
        }
    }

    emitMany(handler, isFn, self, args) {
        if (isFn) {
            if (handler.ctx) self = handler.ctx;
            handler.apply(self, args);
        } else {
            var len = handler.length;
            var listeners = arrayClone(handler, len);
            for (var i = 0; i < len; ++i) {
                if (listeners[i].ctx) self = listeners[i].ctx;
                if (!listeners[i].apply(self, args)) break;
            }
        }
    }

}

module.exports = ModernEventEmitter;
