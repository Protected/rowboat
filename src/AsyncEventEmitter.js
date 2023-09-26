//Simple EventEmitter that:
//  Executes all listeners (handlers) for an event in an asynchronous context
//  Executes all listeners serially
//  Allows propagation interruption using the listener's return (resolve) value (return true to interrupt)
//  Tells the .emit caller if the listener chain was interrupted or not

import logger from './Logger.js';

export default class AsyncEventEmitter {

     AsyncEventEmitter() {
         this._events = null;
     }   


    _addListener(type, listener, prepend) {
        if (typeof listener !== 'function') {
            throw new TypeError('"listener" argument must be a function');
        }

        if (!this._events) {
            this._events = {};
        } else if (this._events.newListener) {
            this.emit('newListener', type, listener);
        }
        
        let existing = this._events[type];

        if (!existing) {
            this._events[type] = listener;
        } else if (typeof existing === 'function') {
            if (existing === listener) return;
            this._events[type] = prepend ? [listener, existing] : [existing, listener];
        } else {
            if (existing.indexOf(listener) > -1) return;
            if (prepend) {
                existing.unshift(listener);
            } else {
                existing.push(listener);
            }
        }
    }


    addListener(type, listener, self) {
        if (typeof listener == "function" && self) listener.ctx = self;
        this._addListener(type, listener, false);
    };
    
    prependListener(type, listener, self) {
        if (typeof listener == "function" && self) listener.ctx = self;
        this._addListener(type, listener, true);
    };
    
    on(type, listener, self) {
        this.addListener(type, listener, self);
    }


    async emit(type, ...args) {
        //Run the asynchronous listeners in asynchronous context so we can chain them
        //True means the event was fully processed; false means it was interrupted

        if (!this._events) return true;

        let handler = this._events[type];
        if (!handler) return true;

        let self = this;
        
        try {
            if (typeof handler === 'function') {
                if (handler.ctx) self = handler.ctx;
                //Forcefully promisify listener and execute it
                await (async () => handler.apply(self, args))();
            } else {
                for (let listener of handler.slice()) {
                    if (listener.ctx) self = listener.ctx;
                    //Forcefully promisify every listener and execute it
                    let result = await (async () => listener.apply(self, args))();
                    if (result === true) return false;
                }
            }
        } catch (e) {
            logger.error("Exception while processing event '" + type + "': " + e + " " + e.stack);
            return false;
        }

        return true;
    }

}
