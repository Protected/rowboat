//Functions for remote communication between modules.
//A: Modules expose their contents.
//B: Modules can communicate with remote modules transparently (configuration).
//C: Modules can add explicit routes.

import express from 'express';
import helmet from 'helmet';
import http from 'http';
import https from 'https';

const router = express();
router.use(helmet());
router.use(express.json());

let logger = null;


function log(method, subject) {
    if (subject === undefined) {
        subject = method;
        method = 'info';
    }
    logger.log(method, '*API* ' + subject);
}


function isModule(mod) {
    let proto = mod.prototype;
    while (proto !== Object.prototype) {
        if (proto.constructor.name === "Module") { return true; }
        proto = Object.getPrototypeOf(proto);
    }
    return false;
}


export function start(rblogger, rbport) {
    logger = rblogger;
    router.listen(rbport, "127.0.0.1", () => {
        log("Listening on port: " + rbport);
    });
}

//Expose the getters (GET), setters (PUT) and methods (POST) of a module on /name/propname
export function expose(mod) {
    if (!mod.expose || !mod || !isModule(mod)) { return false; }
    
    const proto = Object.getPrototypeOf(mod);
    for (const prop of Object.getOwnPropertyNames(proto)) {
        if (prop === "constructor" || prop === "initialize") { continue; }
    
        const desc = Object.getOwnPropertyDescriptor(proto, prop);
        
        if (desc.get) {
            router.get('/' + mod.name + '/' + prop, (req, res) => {
                res.send(mod[prop]);
            });
        }
        
        if (desc.set) {
            router.put('/' + mod.name + '/' + prop, (req, res) => {
                mod[prop] = req.body;
                res.status(200);
            });
        }
        
        if (typeof desc.value === "function") {
            router.post('/' + mod.name + '/' + prop, (req, res) => {
                if (!Array.isArray(req.body)) {
                    res.sendStatus(400);
                }
                const ret = mod[prop].apply(mod, req.body);
                res.status(200);
                res.send(ret);
            });
        }
        
    }

    return true;
}

//Returns a direct module accessor
export function localModule(mod) {
    if (!mod || !isModule(mod)) { return null; }

    const promiseproxy = {};

    const proto = Object.getPrototypeOf(mod);
    for (const prop of Object.getOwnPropertyNames(proto)) {
        if (prop === "constructor" || prop === "initialize") { continue; }
        
        const desc = Object.getOwnPropertyDescriptor(proto, prop);
        
        if (desc.get) {
            Object.defineProperty(promiseproxy, prop, {
                get() {
                    return Promise.resolve(mod[prop]);
                }
            });
        }
        
        if (desc.set) {
            //Setter converted into function setProp because setters can't be asynchronous.
            Object.defineProperty(promiseproxy, 'set' + prop[0].toUpperCase() + prop.substr(1), {
                writable: false,
                value: function(value) {
                    mod[prop] = value;
                    return Promise.resolve();
                }
            });
        }
        
        if (typeof desc.value === "function") {
            Object.defineProperty(promiseproxy, prop, {
                writable: false,
                value: function() {
                    const ret = mod[prop].apply(mod, ...arguments);
                    return Promise.resolve(ret);
                }
            });
        }
        
    }
    
    return promiseproxy;
}


function jsonrequest(url, method, reqbody) {
    return new Promise((resolve, reject) => {
        let req;
        
        const callback = (res) => {
            res.setEncoding('utf8');
            if (res.statusCode !== 200) {
                reject("Request failed: " + res.statusCode);
            } else {
                let body = '';
                res.on('data', (chunk) => body += chunk);
                res.on('end', () => resolve(JSON.parse(body)));
            }
        };
        
        const opts = {
            method: method,
            headers: {
                "Content-type": "application/json"
            }
        };
        
        if (url.match(/^https/i)) {
            req = https.request(url, opts, callback);
        } else {
            req = http.request(url, opts, callback);
        }
        
        req.on('error', reject);
        
        if (reqbody) {
            req.write(JSON.stringify(reqbody));
        }
    });
}

//Returns a remote module accessor
export function remoteModule(mod, baseurl) {
    if (!mod || !isModule(mod)) { return null; }

    const promiseproxy = {};

    const proto = Object.getPrototypeOf(mod);
    for (const prop of Object.getOwnPropertyNames(proto)) {
        if (prop === "constructor" || prop === "initialize") { continue; }
        
        const desc = Object.getOwnPropertyDescriptor(proto, prop);
        
        if (desc.get) {
            Object.defineProperty(promiseproxy, prop, {
                get() {
                    return jsonrequest(baseurl + '/' + mod.name + '/' + prop, 'GET');
                }
            });
        }
        
        if (desc.set) {
            //Setter converted into function setProp because setters can't be asynchronous.
            Object.defineProperty(promiseproxy, 'set' + prop[0].toUpperCase() + prop.substr(1), {
                writable: false,
                value: function(value) {
                    return jsonrequest(baseurl + '/' + mod.name + '/' + prop, 'PUT', value);
                }
            });
        }
        
        if (typeof desc.value === "function") {
            Object.defineProperty(promiseproxy, prop, {
                writable: false,
                value: function() {
                    return jsonrequest(baseurl + '/' + mod.name + '/' + prop, 'POST', arguments);
                }
            });
        }
        
    }
    
    return promiseproxy;    
}
