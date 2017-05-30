# Pity instructions for our non-dev users

Some instructions, ask if you need assistance. We WILL help.

## Installation

You need **node.js** and **npm** installed.

Go to the directory inside which you want to clone the repository (note that this will create a subdirectory).
    
    git clone https://github.com/Protected/rowboat.git
    
    cd rowboat
    
    npm install
    
Ignore unmet optional dependencies.
    
Next you need to add `config/config.json` as well as config files for environments and modules to the `config` directory.

## Config with experimental Setup tool

    node Setup.js --help

Setup is meant to make the configuration process slightly less horrible. If you manage to make it work, skip the next section.

For a new setup, I suggest something like this:

    node Setup.js -u -e Discord,Discord;IRC,IRC Users;Commands;Random;FreeRoles,FreeRoles

You can also try interactive mode instead:

    node Setup.js -u -a -e
    
When you're done, go to the `config` directory and edit the config files (or not).

To learn what each environment or module does, and what their config file parameters do, just open it and check the top of the file. Environments are in the files named `EnvNAME.js` and modules are in `ModNAME.js`.

## Config manually

Copy the example config file

    cd config

    cp config.example.json config.json
    
and edit it. Add your desired environments and modules. The modules have to be ordered in such a way that all modules are listed after all of their requirements. You probably want "Users" followed by "Commands" at the top.

Environments and modules have their own config files. Each config file should contain a JSON map:

    {
        "key": "value",
        ...
    }

Each environment instance represents a connection from the bot to a remote chat environment. Environment config file names are (all lower case) `INSTANCENAME.ENVIRONMENTNAME.env.json` (with `INSTANCENAME` as set in config.json).

Each module adds behavior to the bot. By default, the bot has absolutely no behavior. There are two types of modules: Single and multi instanceable.

* Single-instanceable modules (which are most of them) can only have one instance and their config files are named (all lower case) `MODULENAME.mod.json` .
* Multi-instanceable modules are modules which you may want to load more than once. To use a multi instanceable module, in the list of modules in config.json instead of `"MODULENAME"` use `["INSTANCENAME", "MODULENAME"]`. The config file is then named (all lower case) `INSTANCENAME.MODULENAME.mod.json`.

To learn what each environment or module does, and what are their config file parameters, and what THOSE do, just open it and check the top of the file. Environments are in the files named `EnvNAME.js` and modules are in `ModNAME.js`.

## Run Rowboat

    node Rowboat.js
    
I recommend running inside a screen when not debugging:

    screen -mS myrowboat node Rowboat.js

Since this is a work in progress, if you encounter a bug you may want to try updating using

   git pull
   
   npm update
   
Do not do this with the bot running. Also, we'll be thankful for all legitimate bug reports.
