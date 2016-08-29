var irc = require('irc');
var _ = require('underscore');
var C = require('./Commands.js');
var jf = require('jsonfile');

var argv = require('yargs')
          .default('server','irc.rizon.net')
          .default('nick','Rowboat')
          .default('channel','#discworld')
          .default('password',null)
          .argv
		  ;


var client = new irc.Client(argv.server, argv.nick, {
    channels: [argv.channel],
	userName: 'myshelter',
	realName: 'Not a pun, just a misunderstanding.',
	floodProtection: true,
	floodProtectionDelay: 500,
	stripColors: false,
	password: argv.password
});

var commandList = [];
var callbackList = {};
var users = [];

var PAObj;


//Modules

var modules = [
	{
		name: 'Commands.js',
		exp: undefined,
	},
	{
		name: "Discord.js",
		exp: undefined,
	}
];

function loadModules() {
	commandList = [];
	_.each(modules, function(module) {
		try {
			if (module.exp) {
				module.exp.onReassemble();
            }
			module.exp = requireUncached('./' + module.name);
			module.exp.setMain(PAObj);
			_.each(module.exp.commandList, function(cmd) {
				commandList.push(cmd);
			});
			callbackList[module.name] = module.exp.messageCallback;
		} catch(ex) {
			console.log("[ERR] Loading module '" + module.name + "': " + ex);
		}
	});
}


//EOModules

function loadUsers() {
	users = jf.readFileSync("users.json");
	PAObj.users = users;
};

var loadUsersEvent = setTimeout(loadUsers, 60000);


//Public Access Object

PAObj = {
	client: client,
	checkForPermission: checkForPermission,
	users: users,
	loadUsers: loadUsers,
	commandList: commandList
};


loadUsers();
loadModules();


client.addListener('error', function(message) {
    console.log('error: ', message);
});


client.addListener('message', function (from, to, message, messageObj) {
    var messageArr = message.split(" ");
    var commandStr = messageArr[0].substring(1);

	_.each(modules, function(module) {
		if (callbackList[module.name]) {
			callbackList[module.name](from, to, message, messageObj);
		}
	});

    if (message.charAt(0) == '+') {

		if (commandStr == "reassemble" && checkForPermission(from,messageObj.host, 'z')) {
			console.log(from + ' reassembled me!');

			loadModules();
			return;
		}

		var commandObj = getCommand(commandStr);
		if (commandObj) {
			try {
				var dest;
				if (!checkForPermission(from, messageObj.host, commandObj.permission)) {
					client.notice(from, "Access denied. Flag " + commandObj.permission + " is required.");
					return;
				}
				if (commandObj.minParams && messageArr.length < commandObj.minParams + 1) {
					getCommand("help").func(from, to, from, ['+help', commandStr], messageObj);
                    return;
				}

				console.log(from + " issued the command: " + messageArr);

				if (commandObj.dest) {
					switch (commandObj.dest) {
						case "source":
                            dest = from;
                            break;
						case "channel":
							if (to.charAt(0) == '#') {
								dest = to;
								break;
							} else {
								client.notice(from, "Can't use this command outside a channel.");
								return;
							}
                            break;
						case "any":
						default:
                            dest = (to.charAt(0) == '#' ? to : from);
                            break;
					}
				} else {
					dest = (to.charAt(0) == '#' ? to : from);
				}

				commandObj.func(from, to, dest, messageArr, messageObj);
			} catch(ex) {
				console.log(ex);
			}
		}
		
	}

});


function getCommand(commandStr) {
	return _.find(commandList, function(commandObj) { return commandObj.command.toLowerCase() == commandStr.toLowerCase() });
}

//Reload

function requireUncached(module) {
    delete require.cache[require.resolve(module)];
    return require(module);
}

function compareChannelLevels(l1, l2) {
	var values = {
		"~" : 20,
		"&" : 15,
		"!" : 10,
		"@" : 5,
		"%" : 4,
		"+" : 3
	};

    var v1 = 0;
    for (var i = 0; i < l1.length; i++) {
        try {
            v1 = Math.max(v1, values[l1[i]]);
        } catch(e) {}
    }
    
    var v2 = 0;
    for (var i = 0; i < l2.length; i++) {
        try {
            v2 = Math.max(v2, values[l2[i]]);
        } catch(e) {}
    }
    
	return v1 >= v2;
}


function checkForPermission (nick, vhost, permission) {
	if (users.length == 0) return true;
	if (typeof permission === 'undefined') return true;
	var regexVhost = new RegExp(vhost,'i');
	var user = _.find(users, function(usr) { return usr.nick.toLowerCase() == nick.toLowerCase();});
	if (!user) return false;
	if (!user.host.match(regexVhost)) return false;
	if (user.permissions.indexOf(permission) > -1 || user.permissions.indexOf('z') > -1) return true;
	return false;
}
