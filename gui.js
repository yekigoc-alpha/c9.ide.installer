define(function(require, exports, module) {
    main.consumes = [
        "Wizard", "WizardPage", "ui", "installer", "Datagrid", "settings",
        "menus", "commands", "Terminal"
    ];
    main.provides = ["installer.gui"];
    return main;

    function main(options, imports, register) {
        var Wizard = imports.Wizard;
        var WizardPage = imports.WizardPage;
        var ui = imports.ui;
        var installer = imports.installer;
        var commands = imports.commands;
        var menus = imports.menus;
        var settings = imports.settings;
        var Datagrid = imports.Datagrid;
        var Terminal = imports.Terminal;
        
        var async = require("async");
        
        var RED = "\x1b[01;31m";
        var GREEN = "\x1b[01;32m";
        var YELLOW = "\x1b[01;33m";
        var BLUE = "\x1b[01;34m";
        var MAGENTA = "\x1b[01;35m";
        var LIGHTBlUE = "\x1b[01;94m";
        var RESETCOLOR = "\x1b[0m";
        var BOLD = "\x1b[01;1m";
        var UNBOLD = "\x1b[01;21m";
        
        /***** Initialization *****/
        
        var plugin = new Wizard("Ajax.org", main.consumes, {
            title: "Cloud9 Installer",
            allowClose: true,
            class: "installer",
            resizable: true,
            height: 400
        });
        
        var logDiv, spinner, lastOutput, datagrid, aborting;
        var intro, overview, execute, complete, cbAlways, terminal;
        var sessions = [];
        var executeList;
        
        function load(){
            if (options.testing)
                return plugin.show(true);
            
            commands.addCommand({
                name: "showinstaller",
                exec: function(editor, args){ 
                    if (plugin.visible) return;
                    
                    if (args && args.packages) {
                        args.packages.forEach(function(name){
                            installer.reinstall(name);
                        });
                        return;
                    }
                    
                    plugin.startPage = overview;
                    plugin.show(true);
                }
            }, plugin);
            
            menus.addItemByPath("Window/Installer...", new ui.item({
                command: "showinstaller"
            }), 38, plugin);
            
            // Handle error state during headless installation
            installer.on("stop", function(e){
                if (plugin.visible || !e.error) return;
                
                plugin.startPage = execute;
                plugin.show(true);
                
                plugin.showFinish = true;
                plugin.showNext = false;
                plugin.showPrevious = false;
                plugin.showCancel = false;
                  
                spinner.style.display = "none";
                logDiv.className = "log details";
                
                clear();
                
                sessions.forEach(function(session){
                    if (session.output)
                        log(session.output);
                });
                
                logln("\n" + e.error.message + "\n\n" + RED + 
                      + "One or more errors occured. "
                      + "Please try to resolve them and\n"
                      + "restart Cloud9 or contact support@c9.io." + RESETCOLOR);
            }, plugin);
            
            // Hook the creation of new sessions
            installer.on("beforeStart", beforeStart, plugin);
            
            // Make sure GUI picks up reinstalls
            installer.on("reinstall", function(e){
                var prefs = settings.getJson("state/installer");
                var pref = prefs[e.name] || 0;
                delete pref.$version;
                settings.setJson("state/installer", prefs);
            }, plugin);
        }
        
        function beforeStart(e){
            var session = e.session;
            
            // Reset aborting state
            aborting = false;
            
            // Add session to global array
            sessions.push(session);
            
            // Run headless if the user has previous chosen that
            if (settings.getBool("user/installer/@auto")) {
                // Clean up sessions array after session stopped
                session.once("stop", function(){ sessions.remove(session); });
                return;
            }
            
            var hasOptional = session.tasks.some(function(n){ 
                return (n.$options || 0).optional;
            });
            
            // Ignore sessions if previously decided not to install
            var pref = settings.getJson("state/installer")[session.package.name] || 0;
            
            if (pref.$version !== session.package.version
              && (session.introduction || hasOptional)) {
                draw();
                
                if (!plugin.visible) {
                    plugin.startPage = session.introduction ? intro : overview;
                    plugin.allowClose = installer.checked;
                    plugin.show(true, { queue: false });
                }
                else {
                    if (plugin.activePage.name != "execute" && plugin.activePage.name != "done") {
                        // if (session.introduction) {
                        //     if (plugin.activePage != intro)
                        //        plugin.gotoPage(intro);
                            
                        //     updateIntro();
                        // }
                        
                        updatePackages();
                    }
                    else {
                        sessions.remove(session);
                        
                        plugin.once("hide", function(){
                            beforeStart(e);
                        });
                        
                        return;
                    }
                }
            }
            else if (plugin.visible) {
                updatePackages();
            }
            else return;
            
            return false;
        }
        
        var drawn;
        function draw(){
            if (drawn) return;
            drawn = true;
            
            ui.insertCss(require("text!./style.css"), options.staticPrefix, plugin);
            
            // Page Intro - displays intro texts
            intro = new WizardPage({ name: "intro" }, plugin);
            intro.on("draw", function(e) {
                ui.insertHtml(e.html, 
                    require("text!./pages/intro.html"), intro);
            });
            intro.on("show", function(){
                updateIntro();
            });
            
            // Page Overview - givs an overview of the components to install
            overview = new WizardPage({ name: "overview" }, plugin);
            overview.on("draw", function(e) {
                ui.insertHtml(e.html, 
                    require("text!./pages/overview.html"), overview);
                
                datagrid = new Datagrid({
                    container: e.html.querySelector("blockquote"),
                    enableCheckboxes: true,
                    
                    columns : [
                        {
                            caption: "Name",
                            value: "name",
                            width: "35%",
                            type: "tree"
                        }, 
                        {
                            caption: "Description",
                            value: "description",
                            width: "65%"
                        }
                    ],
                    
                    getClassName: function(node){
                        return !node.optional ? "required" : "";
                    }
                
                    // getIconHTML: function(node) {
                    //     var icon = node.isFolder ? "folder" : "default";
                    //     if (node.status === "loading") icon = "loading";
                    //     return "<span class='ace_tree-icon " + icon + "'></span>";
                    // }
                }, plugin);
                
                function updateParents(nodes){
                    var parents = {}, toChildren = {};
                    nodes.forEach(function(n){ 
                        if (!n.parent.label) { // Root
                            toChildren[n.label] = true;
                            parents[n.label] = n;
                        }
                        else if (!n.optional)
                            n.isChecked = true;
                        else
                            parents[n.parent.label] = n.parent;
                    });
                    
                    Object.keys(parents).forEach(function(label){
                        var parent = parents[label];
                        
                        if (toChildren[label]) {
                            var all = true;
                            var hasUnchecked = parent.items.some(function(n){ 
                                return nodes.indexOf(n) == -1 && !n.isChecked 
                            });
                            if (hasUnchecked) parent.isChecked = true;
                            
                            parent.items.forEach(function(n){
                                if (!n.optional) all = false;
                                else n.isChecked = parent.isChecked ? true : false;
                            });
                            if (!all && !parent.isChecked)
                                parent.isChecked = -1;
                            return;
                        }
                        
                        var state = 0;
                        parent.items.forEach(function(n){
                            if (n.isChecked) state++;
                        });
                        if (state == parent.items.length)
                            parent.isChecked = true;
                        else
                            parent.isChecked = state ? -1 : false;
                    });
                    
                    if (getSelectedSessions().length === 0) {
                        plugin.showFinish = true;
                        plugin.showNext = false;
                    }
                    else {
                        plugin.showFinish = false;
                        plugin.showNext = true;
                    }
                }
                
                datagrid.on("check", updateParents);
                datagrid.on("uncheck", updateParents);
            });
            overview.on("show", function(){
                updatePackages();
                
                if (getSelectedSessions().length === 0) {
                    plugin.showFinish = true;
                    plugin.showNext = false;
                }
                else {
                    plugin.showFinish = false;
                    plugin.showNext = true;
                }
            });
            
            // Page Execute - Show Log Output & Checkbox
            execute = new WizardPage({ name: "execute" }, plugin);
            execute.on("draw", function(e) {
                var div = e.html;
                ui.insertHtml(div, require("text!./pages/execute.html"), execute);
                
                logDiv = div.querySelector(".log");
                spinner = div.querySelector(".progress");
                
                terminal = new Terminal({
                    container: logDiv
                }, plugin);
                
                var cb = div.querySelector("#details");
                cb.addEventListener("click", function(){
                    toggleLogDetails(cb.checked);
                });
                
                plugin.addOther(function(){
                    div.innerHTML = "";
                    div.parentNode.removeChild(div);
                });
            });
            
            // Page Complete - The installer has finished
            complete = new WizardPage({ name: "complete" }, plugin);
            complete.on("draw", function(e) {
                ui.insertHtml(e.html, require("text!./pages/complete.html"), complete);
                setCompleteMessage();
                plugin.showPrevious = false;
                plugin.showFinish = true;
            });
            
            // plugin.on("previous", function(e) {
            //     var page = e.activePage;
            // });
            
            plugin.on("next", function(e) {
                cbAlways.show();
                
                var page = e.activePage;
                if (page.name == "intro") {
                    return overview;
                }
                else if (page.name == "overview") {
                    cbAlways.hide();
                    setTimeout(start);
                    return execute;
                }
                else if (page.name == "execute") {
                    plugin.showFinish = true;
                    plugin.showPrevious = false;
                    plugin.showNext = false;
                    return complete;
                }
            });
            
            plugin.on("cancel", function(e) {
                if (e.activePage.name == "execute") {
                    aborting = true;
                    
                    setCompleteMessage("Installation Aborted",
                        require("text!./install/aborted.html"));
                    
                    plugin.gotoPage(complete);
                    plugin.showCancel = false;
                        
                    executeList.forEach(function(session){
                        if (session.executing)
                            session.abort();
                    });
                }
            });
            
            plugin.on("finish", function(e){
                cbAlways.show();
                if (!cbAlways.checked || e.activePage.name == "complete") return;
                runHeadless();
            });
            
            plugin.startPage = intro;
        }
        
        /***** Methods *****/
        
        function updateIntro(){
            var html = "";
            
            sessions.forEach(function(session){
                html += session.introduction || "";
            });
            intro.container.querySelector("blockquote").innerHTML = html;
        }
        
        function updatePackages(){
            if (!datagrid) return;
            
            var root = { items: [] };
            
            // Ignore sessions if previously decided not to install
            var prefs = settings.getJson("state/installer");
            
            sessions.forEach(function(session){
                var sessionState = prefs[session.package.name] || 0;
                
                var node = { 
                    label: session.package.name, 
                    description: "Version " + session.package.version,
                    session: session,
                    items: [],
                    isOpen: false
                };
                root.items.push(node);
                
                var optional = false, checked = 0;
                session.tasks.forEach(function(task){
                    var options = task.$options;
                    if (!options) return;
                    
                    if (options.optional) {
                        optional = true;
                        options.ignore = sessionState[options.name] || false;
                    }
                    if (options.isChecked === undefined)
                        options.isChecked = options.ignore ? false : true;
                    checked += options.isChecked ? 1 : 0;
                    node.items.push(options);
                });
                
                // var ignoreVersion = sessionState.$version === session.package.version;
                node.isChecked = checked == 0 
                    ? false 
                    : (checked == session.tasks.length ? true : -1);
                node.optional = optional;
            });
            
            datagrid.setRoot(root);
        }
        
        var lastComplete;
        function setCompleteMessage(title, msg){
            if (!complete.container)
                return (lastComplete = [title, msg]);
                
            complete.container.querySelector("h3").innerHTML = title || lastComplete[0];
            complete.container.querySelector("blockquote").innerHTML = msg || lastComplete[1];
        }
        
        function getSelectedSessions(ignored, state){
            var sessions = [];
            
            var nodes = datagrid.root.items;
            nodes.filter(function(node){
                var include = typeof node.isChecked == "boolean"
                    ? node.isChecked
                    : true;
                
                var sessionState;
                var session = node.session;
                if (state) sessionState = state[session.package.name] = {};
                session.tasks.forEach(function(task){
                    task.$options.ignore = task.$options.isChecked === false;
                    if (sessionState)
                        sessionState[task.$options.name] = task.$options.ignore;
                });
                
                if (!include) {
                    if (sessionState)
                        sessionState.$version = session.package.version;
                    if (ignored) ignored.push(session);
                    return false;
                }
                
                sessions.push(session);
            });
            
            return sessions;
        }
        
        function clear(){
            logDiv.innerHTML = "";
        }
        
        function log(msg) {
            terminal.convertEol = !installer.checked;
            
            // (lastOutput || logDiv).insertAdjacentHTML("beforeend", msg);
            // logDiv.scrollTop = logDiv.scrollHeight;
            terminal.write(msg);
        }
        
        function logln(msg, color, unset) {
            terminal.convertEol = !installer.checked;
            
            // logDiv.insertAdjacentHTML("beforeend", msg + "<br />");
            // logDiv.scrollTop = logDiv.scrollHeight;
            terminal.write((color || "") + msg + (color ? unset || RESETCOLOR : "") + "\n");
        }
        
        function toggleLogDetails(show){
            
        }
        
        function start(services, callback) {
            plugin.showCancel = true;
            
            plugin.showPrevious = false;
            plugin.showNext = false;
            
            // Start Installation
            logln("Installation Started", LIGHTBlUE);
            logln("");
            spinner.style.display = "block";
            
            var aborted = [];
            var state = {};
            executeList = getSelectedSessions(aborted, state);
            sessions = [];
            
            // Store selection in state settings
            settings.setJson("state/installer", state);
            
            // Abort sessions that won't be run
            aborted.forEach(function(session){
                session.abort();
            });
            
            // Run all selected sessions
            async.eachSeries(executeList, function(session, next){
                if (aborting) return next(new Error("Aborted"));
                
                session.on("run", function(){
                    var heading = "Package " + session.package.name 
                        + " " + session.package.version;
                    logln(heading + "\n" + Array(heading.length + 1).join("-"));
                });
                
                var lastOptions;
                session.on("each", function(e){
                    if (lastOptions != e.options) {
                        lastOptions = e.options;
                        if (e.options.name)
                            logln("Installing " + e.options.name, BLUE);
                    }
                });
                session.on("data", function(e){
                    log(e.data);
                    
                    // @TODO detect password: input
                });
                
                session.start(next, true);
            }, function(err){
                logDiv.scrollTop = logDiv.scrollHeight;
                
                plugin.showCancel = false;
                
                if (err) {
                    logln("\n" + err.message + "\n\n" + RED + 
                      + "One or more errors occured. "
                      + "Please try to resolve them and\n"
                      + "restart Cloud9 or contact support@c9.io." + RESETCOLOR);
                      
                    spinner.style.display = "none";
                    logDiv.className = "log details";
                    
                    if (plugin.activePage.name == "execute")
                        plugin.showFinish = true;
                }
                else {
                    logln("");
                    logln("Installation Completed.", LIGHTBlUE);
                    
                    spinner.style.display = "none";
                    
                    setCompleteMessage("Installation Complete",
                        require("text!./install/success.html")
                            .replace("{{sessions}}", executeList.map(function(s){
                                return s.package.name + " " + s.package.version;
                            }).join("</li><li>")));
                    plugin.showNext = true;
                }
            });
        }
        
        function runHeadless(){
            sessions.forEach(function(session){
                session.start(function(){}, true);
            });
        }
        
        /***** Lifecycle *****/
        
        plugin.on("draw", function(){
            draw();
            
            // Add Checkbox to toggle Always Installation
            plugin.createElement({ 
                id: "cbAlways", 
                type: "checkbox", 
                caption: "Always install everything", 
                position: 150
            });
            cbAlways = plugin.getElement("cbAlways");
            
            var lastState = {};
            cbAlways.on("afterchange", function(e){
                if (e.value) {
                    ["showCancel", "showFinish", "showNext", "showPrevious"]
                        .forEach(function(n){ lastState[n] = plugin[n]; });
                    
                    plugin.showCancel = false;
                    plugin.showFinish = true;
                    plugin.showNext = false;
                    plugin.showPrevious = false;
                }
                else {
                    ["showCancel", "showFinish", "showNext", "showPrevious"]
                        .forEach(function(n){ plugin[n] = lastState[n]; });
                }
                
                settings.set("user/installer/@auto", e.value);
            });
        });
        
        plugin.on("show", function(){
            // Make sure all items that were previously not installed are listed again.
            var prefs = settings.getJson("state/installer");
            for (var pkgName in prefs) {
                if (!sessions.some(function(n){ return n.package.name == pkgName; })) {
                    installer.reinstall(pkgName, true);
                }
            }
        });
        
        plugin.on("load", function(){
            load();
        });
        
        plugin.on("unload", function(){
            aborting = false;
            terminal = null;
            logDiv = null;
            spinner = null;
            lastOutput = null;
            intro = null;
            overview = null;
            execute = null;
            complete = null;
            drawn = null;
            datagrid = null;
            lastComplete = null;
            executeList = null;
            cbAlways = null;
            sessions = [];
        });
        
        plugin.on("resize", function(){
            terminal && terminal.resize();
        });
        
        /***** Register and define API *****/
        
        /**
         * Installer for Cloud9
         **/
        plugin.freezePublicAPI({
            
        });
        
        register(null, {
            "installer.gui": plugin
        });
    }
});