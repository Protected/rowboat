/* Module: API -- Used by other modules to provide a HTTP+JSON API for other applications, local or remote. */

//Requests to the API use the POST method, have no path and contain the following JSON in the body: {module; ..., method: ..., args: {name: value, ...}}

const Module = require('../Module.js');
const http = require('http');

class ModAPI extends Module {

    get optionalParams() { return [
        'host',                 //Local IP address for the HTTP server to listen on. Use 0.0.0.0 for any.
        'port'                  //Port for the HTTP server to listen on.
    ]; }

    constructor(name) {
        super('API', name);
        
        this._params['host'] = '127.0.0.1';
        this._params['port'] = 8098;
        
        this._server = null;
        this._methods = [];  //List of {mod, methodname, args: [...]}
    }
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;

      
        this._server = http.createServer((request, response) => {
        
            if (request.method != 'POST') {
                response.statusCode = 404;
                return response.end();
            }
            
            let body = '';
            request.on('data', (data) => {
                body += data;
            });
            
            request.on('end', () => {
                
                let json = null;
                try {
                    json = JSON.parse(body);
                } catch (err) {
                    response.statusCode = 400;
                    return response.end();
                }
                
                if (!json || !json.module || !json.method) {
                    response.statusCode = 400;
                    return response.end();
                }
                
                let info = this._methods.find(item => item.mod.name == json.module && item.methodname == json.method);
                if (!info) {
                    this.log('warn', '(NOT FOUND) ' + request.headers.host + ' => ' + json.module + '.' + json.method);
                    response.statusCode = 404;
                    return response.end();
                }
                
                let args = [];
                if (json.args && info.args) {
                    for (let arg of info.args) {
                        args.push(json.args[arg]);
                    }
                }
                
                this.log(request.headers.host + ' => ' + json.module + '.' + json.method + '(' + args.join(', ') + ')');
                
                if (!info.mod[info.methodname] || typeof info.mod[info.methodname] != "function") {
                    this.log('error', request.headers.host + ' <= IMPLEMENTATION MISSING?');
                    response.statusCode = 503;
                    return response.end();
                }
                
                let res = null;
                try {
                    res = info.mod[info.methodname].apply(info.mod, args);
                } catch (err) {
                    this.log('error', request.headers.host + ' <= Error in implementation: ' + err);
                    response.statusCode = 500;
                    return response.end();
                }
                
                if (typeof res == "object") res = JSON.stringify(res);
                
                this.log(request.headers.host + ' <= ' + res);
                
                response.statusCode = 200;
                response.write(String(res));
                response.end();
            });

        });
        
        this._server.listen(this.param('port'), this.param('host'), (err) => {  
            if (err) this.log('error', err);
            else this.log('Listening on port ' + this.param('port'));
        });
        
      
        return true;
    };
    
    
    // # Module code below this line #
    
    
    //Use this method from dependent modules to expose one of their methods.
    
    registerMethod(mod, methodname, args) {
        if (!mod || !mod.name || !mod.modName) {
            this.log('warn', 'Failed to register method: The first argument must be the registering module.');
            return false;
        }
        
        if (!methodname || !mod[methodname] || typeof mod[methodname] != "function") {
            this.log('warn', 'Failed to register method: The method does not exist in the module.');
            return false;
        }
        
        if (!args) args = [];
        if (!args.length) {
            this.log('warn', 'Failed to register method: The list of arguments should contain argument names in the order that they will be passed to the method.');
            return false;
        }
        
        this._methods.push({mod: mod, methodname: methodname, args: args});
    }


}


module.exports = ModAPI;
