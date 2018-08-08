/* Module: Users -- Manage "known" user accounts and permission flags. */

var fs = require('fs-extra');
var jsonfile = require('jsonfile');
var archiver = require('archiver');
var path = require('path');

var environments = null;
var modules = null;
var userdata = [];
var userhandles = {};

var datafile = 'users.data.json';


var PERM_ADMIN = 'administrator';
var PERM_MOD = 'moderator';


var modname = "Users";
exports.name = modname;


exports.requiredenvironments = [];
exports.requiredmodules = [];


exports.initialize = function(envs, mods, moduleRequest) {

    //Load parameters

    if (!envs) return false;
    environments = envs;
    modules = mods;
    
    
    //Load data
    
    if (!loadUsers(datafile)) return false;

    
    //Register callbacks
    
    moduleRequest('Commands', function(commands) {
    
    
        commands.registerCommand('useradd', {
            args: ["handle"],
            description: "Create a new empty user account with the given handle.",
            types: ["private"],
            permissions: [PERM_ADMIN]
        }, function(env, type, userid, command, args, handle, reply) {
        
            if (addUser(args.handle)) {
                reply("The account " + args.handle + " was successfuly created.");
            } else {
                reply("There already exists an account identified by " + args.handle + "!");
            }
            
            return true;
        });
        
        
        commands.registerCommand('userdel', {
            args: ["handle"],
            description: "Delete an existing user account identified by the given handle.",
            types: ["private"],
            permissions: [PERM_ADMIN]
        }, function(env, type, userid, command, args, handle, reply) {
        
            if (delUser(args.handle)) {
                reply("The account " + args.handle + " was successfully deleted.");
            } else {
                reply("I could not find an account identified by " + args.handle + "!");
            }
            
            return true;
        });
        
        
        commands.registerCommand('idadd', {
            args: ["handle", "environment", "idpattern"],
            description: "Add an ID pattern (regex) to authenticate the user account identified by the handle in the specified environment.",
            types: ["private"],
            permissions: [PERM_ADMIN]
        }, function(env, type, userid, command, args, handle, reply) {
        
            args.idpattern = "^" + args.idpattern + "$";
            if (!environments[args.environment]) {
                reply("There is no environment named " + args.environment + " at this time.");
                return true;
            }
            
            if (addId(args.handle, args.environment, args.idpattern)) {
                reply("Successfully added the requested pattern to the account identified by " + args.handle + ".");
            } else {
                reply("I could not find an account identified by " + args.handle + "!");
            }
            
            return true;
        });
        
        
        commands.registerCommand('iddel', {
            args: ["handle", "environment", "idpattern"],
            description: "Remove an existing ID pattern from a user such that it will no longer authenticate the user account identified by the handle.",
            types: ["private"],
            permissions: [PERM_ADMIN]
        }, function(env, type, userid, command, args, handle, reply) {
            
            args.idpattern = "^" + args.idpattern + "$";
            
            if (delId(args.handle, args.environment, args.idpattern)) {
                reply("Successfully removed the requested patterm from the account identified by " + args.handle + ".");
            } else {
                reply("I could not find an account identified by " + args.handle + "!");
            }
            
            return true;
        });
        
        
        commands.registerCommand('permadd', {
            args: ["handle", "permissions", true],
            minArgs: 2,
            description: "Add one or more permissions to the user account identified by the handle.",
            permissions: [PERM_ADMIN]
        }, function(env, type, userid, command, args, handle, reply) {
        
            if (addPerms(args.handle, args.permissions)) {
                reply("The permissions listed were added to the account identified by " + args.handle + ".");
            } else {
                reply("I could not find an account identified by " + args.handle + "!");
            }
        
            return true;
        });
        
        
        commands.registerCommand('permdel', {
            args: ["handle", "permissions", true],
            minArgs: 2,
            description: "Remove one or more permissions from the user account identified by the handle.",
            permissions: [PERM_ADMIN]
        }, function(env, type, userid, command, args, handle, reply) {
        
            if (delPerms(args.handle, args.permissions)) {
                reply("The permissions listed were removed from the account identified by " + args.handle + ".");
            } else {
                reply("I could not find an account identified by " + args.handle + "!");
            }
        
            return true;
        });
        
        
        commands.registerCommand('userfind', {
            args: ["environment", "id"],
            description: "List the handles of the user accounts that match the given id and environment.",
            types: ["private"],
            permissions: [PERM_ADMIN, PERM_MOD]
        }, function(env, type, userid, command, args, handle, reply) {
        
            var handles = getHandlesById(args.environment, args.id);
            if (!handles.length) {
                reply("No handles were found matching the given environment and id.");
                return true;
            }
            
            while(handles.length) {
                var outbound = handles.slice(0, 10);
                outbound = '"' + outbound.join('","') + '"';
                reply(outbound);
                handles = handles.slice(10);
            }
        
            return true;
        });
        
        
        commands.registerCommand('whois', {
            args: ["handle"],
            description: "Describe the user account identified by the handle.",
            types: ["private"],
            permissions: [PERM_ADMIN, PERM_MOD]
        }, function(env, type, userid, command, args, handle, reply) {
        
            var account = getUser(args.handle);
            if (!account) {
                reply("I could not find an account identified by " + args.handle + "!");
                return true;
            }
            
            reply('========== ' + account.handle + ' ==========');
            
            reply('* ID patterns:');
            if (account.ids) {
                for (var i = 0; i < account.ids.length; i++) {
                    reply('    {' + account.ids[i].env + '} ' + account.ids[i].idpattern);
                }
            }
            
            reply('* Permissions:');
            var perms = account.perms;
            if (perms) {
                while (perms.length) {
                    var outbound = perms.slice(0, 10);
                    outbound = outbound.join(', ');
                    reply(outbound);
                    perms = perms.slice(10);
                }
            }
            
            reply('.');
        
            return true;
        });
    
    
    });
    
    return true;
};


// # Module code below this line #


//User account manipulation (new accounts only have a handle)

function loadUsers(datafile) {
    try {
        fs.accessSync(datafile, fs.F_OK);
    } catch (e) {
        jsonfile.writeFile(datafile, []);
    }

    try {
        userdata = jsonfile.readFileSync(datafile);
    } catch (e) {
        return false;
    }
    if (!userdata) userdata = [];
    
    userhandles = {};
    for (var i = 0; i < userdata.length; i++) {
        userhandles[userdata[i].handle] = userdata[i];
    }
    
    return true;
}

function saveUsers(dest, data) {
    return fs.exists(dest)
        .then(function (exists) {
            console.log(dest + " exists? " + exists);
            if (exists) {
                return archive(dest);
            }
        })
        .then(function () {
            return fs.writeFile(dest, JSON.stringify(data))
        })
}

function getNextArchiveName(destFile) {
    let archivePath = path.dirname(destFile);
    let targetName = path.basename(destFile);
    let files = fs.readdirSync(archivePath);
    let rex = new RegExp(targetName + "\\.(\\d)\\.tar\\.gz");
    let indices = files.map(f => {
        let match = rex.exec(f);
        return match != null ? match[1] : null;
    }).filter(ar => ar != null);

    let maxIndex = Math.max.apply(null, indices);
    maxIndex = maxIndex < 0 ? 0 : maxIndex;
    return destFile + "." + maxIndex + ".tar.gz";
}

function archive(dest) {
    return new Promise(function (resolve, reject) {

        console.log("Archiving " + dest);
        let archiveName = getNextArchiveName(dest);

        var output = fs.createWriteStream(archiveName);
        var archive = archiver('tar', {
            gzip: true,
        });

        output.on('close', function () {
            console.log(dest + " archived, " + archive.pointer() + ' total bytes written');
            resolve();
        });

        archive.on('warning', function (err) {
            if (err.code === 'ENOENT') {
                console.warn("Trying to archive file " + dest);
                console.warn(err);
            } else {
                reject(err);
            }
        });

        archive.on('error', function (err) {
            reject(err);
        });

        archive.pipe(output);
        archive.file(dest, {name: path.basename(dest)});
        archive.finalize();
    });
}

function addUser(handle) {
    if (userhandles[handle]) return false;

    var newuser = {
        handle: handle,
        ids: [],
        perms: []
    }
    userdata.push(newuser);
    userhandles[handle] = newuser;

    saveUsers(datafile, userdata);
    return true;
}

function delUser(handle) {
    if (!userhandles[handle]) return false;
    
    var i = userdata.findIndex(function(checkuser) {
        return checkuser.handle == handle;
    });
    
    if (i > -1) userdata.splice(i, 1);
    delete userhandles[handle];
    
    saveUsers(datafile);
    return true;
}

function getUser(handle) {
    return userhandles[handle];
}


//User ID manipulation - Identify a user in a specific environment as being the owner of the account. idpattern matches the environment's authorid/targetid.

function addId(handle, env, idpattern) {
    if (!env || !idpattern) return false;
    
    var changed = false;
    var chuser = getUser(handle);
    if (!chuser) return false;

    if (!chuser.ids.find(function(id) { return id.env == env && id.idpattern == idpattern; })) {
        chuser.ids.push({env: env, idpattern: idpattern});
        changed = true;
    }

    if (changed) saveUsers(datafile, userdata);
    return true;
}

function delId(handle, env, idpattern) {
    if (!env) return false;
    
    var changed = false;
    var chuser = getUser(handle);
    if (!chuser) return false;
    
    for (var i = 0; i < chuser.ids.length; i++) {
        if (chuser.ids[i].env != env) continue;
        if (idpattern && chuser.ids[i].idpattern != idpattern) continue;
        chuser.ids.splice(i, 1);
        changed = true;
        i -= 1;
    }

    if (changed) saveUsers(datafile, userdata);
    return true;
}

function getIds(handle, env) {
    var chuser = getUser(handle);
    if (!chuser) return [];

    if (!env) return chuser.ids;

    return chuser.ids.map(function(item) {
        return (item.env == env ? item.idpattern : null);
    }).filter(function(idpattern) {
        return idpattern != null;
    });
}

function isIdHandle(handle, env, id, strict) {
    if (strict) {
        if (!environments[env].idIsSecured || !environments[env].idIsAuthenticated) {
            return false;
        }
    }

    var ids = getIds(handle, env);

    for (var i = 0; i < ids.length; i++) {
        if (RegExp(ids[i]).exec(id)) {
            return true;
        }
    }

    return false;
}

function getHandlesById(env, id, strict) {
    var result = [];

    for (var i = 0; i < userdata.length; i++) {
        if (isIdHandle(userdata[i].handle, env, id, strict)) {
            result.push(userdata[i].handle);
        }
    }

    return result;
}


//Permission manipulation - A permission is a literal which the user may have or not. Permissions are meaningless unless used by other modules.

function addPerms(handle, perms) {
    if (!perms) return false;

    var changed = false;
    var chuser = getUser(handle);
    if (!chuser) return false;

    for (var i = 0; i < perms.length; i++) {
        var perm = perms[i].toLowerCase();
        if (!chuser.perms.find(function(checkperm) { return checkperm == perm; })) {
            chuser.perms.push(perm);
            changed = true;
        }
    }

    if (changed) saveUsers(datafile, userdata);
    return true;
}

function delPerms(handle, perms) {
    if (!perms) return false;

    var changed = false;
    var chuser = getUser(handle);
    if (!chuser) return false;

    for (var i = 0; i < perms.length; i++) {
        var perm = perms[i].toLowerCase();
        var ind = chuser.perms.findIndex(function(checkperm) { return checkperm == perm; });
        if (ind > -1) {
            chuser.perms.splice(ind, 1);
            changed = true;
        }
    }

    if (changed) saveUsers(datafile, userdata);
    return true;
}

function getPerms(handle) {
    var checkuser = getUser(handle);
    if (!checkuser) return [];
    return checkuser.perms;
}

function hasAllPerms(handle, perms) {
    var checkuser = getUser(handle);
    if (!checkuser) return false;
    for (var i = 0; i < perms.length; i++) {
        var perm = perms[i].toLowerCase();
        if (!checkuser.perms.find(function (checkperm) {
            return checkperm == perm;
        })) {
            return false;
        }
    }
    return true;
}

function hasAnyPerm(handle, perms) {
    var checkuser = getUser(handle);
    if (!checkuser) return false;
    for (var i = 0; i < perms.length; i++) {
        var perm = perms[i].toLowerCase();
        if (checkuser.perms.find(function (checkperm) {
            return checkperm == perm;
        })) {
            return true;
        }
    }
    return false;
}


//Exports for dependent modules

exports.isIdHandle = isIdHandle;
exports.getHandlesById = getHandlesById;
exports.getPerms = getPerms;
exports.hasAllPerms = hasAllPerms;
exports.hasAnyPerm = hasAnyPerm;

exports.saveUsers = saveUsers;

