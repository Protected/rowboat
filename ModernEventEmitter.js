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



    emit(type) {
        var er, handler, len, args, i, events;

        events = this._events;
        if (!events) return false;

        handler = events[type];
        if (!handler) return false;

        var self = this;
        var isFn = typeof handler === 'function';
        if (isFn && handler.ctx) self = handler.ctx;
        
        len = arguments.length;
        switch (len) {
            // fast cases
            case 1:
                this.emitNone(handler, isFn, self);
                break;
            case 2:
                this.emitOne(handler, isFn, self, arguments[1]);
                break;
            case 3:
                this.emitTwo(handler, isFn, self, arguments[1], arguments[2]);
                break;
            case 4:
                this.emitThree(handler, isFn, self, arguments[1], arguments[2], arguments[3]);
                break;
            // slower
            default:
                args = new Array(len - 1);
                for (i = 1; i < len; i++)
                    args[i - 1] = arguments[i];
                this.emitMany(handler, isFn, self, args);
        }

        return true;
    }


    emitNone (handler, isFn, self) {
        if (isFn) {
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
