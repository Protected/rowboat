'use strict';

//Based on node.js EventEmitter as of node 7.x

class ModernEventEmitter {

     ModernEventEmitter() {
         this._events = null;
         this._eventsCount = 0;
     }   


    _addListener(type, listener, prepend) {
        var existing;

        if (typeof listener !== 'function')
            throw new TypeError('"listener" argument must be a function');

        if (!this._events) {
            this._events = {};
            this._eventsCount = 0;
        } else if (this._events.newListener) {
            this.emit('newListener', type, listener);
        }
        
        existing = this._events[type];

        if (!existing) {
            existing = this._events[type] = listener;
            ++this._eventsCount;
        } else {
            if (typeof existing === 'function') {
                if (existing === listener) return;
                existing = this._events[type] = prepend ? [listener, existing] : [existing, listener];
            } else {
                if (existing.indexOf(listener) > -1) return;
                if (prepend) {
                    existing.unshift(listener);
                } else {
                    existing.push(listener);
                }
            }
        }
    }


    addListener(type, listener, self) {
        if (typeof listener == "function" && self) listener.ctx = self;
        return this._addListener(type, listener, false);
    };
    
    prependListener(type, listener, self) {
        if (typeof listener == "function" && self) listener.ctx = self;
        return this._addListener(type, listener, true);
    };
    
    on(type, listener, self) {
        this.addListener(type, listener, self);
    }



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
                if (listeners[i].call(self) === true) break;
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
                if (listeners[i].call(self, arg1) === true) break;
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
                if (listeners[i].call(self, arg1, arg2) === true) break;
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
                if (listeners[i].call(self, arg1, arg2, arg3) === true) break;
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
                if (listeners[i].apply(self, args) === true) break;
            }
        }
    }

}

module.exports = ModernEventEmitter;



function arrayClone(arr, i) {
    var copy = new Array(i);
    while (i--) copy[i] = arr[i];
    return copy;
}
