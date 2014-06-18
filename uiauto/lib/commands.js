// The messages route is the following:
// Appium <--> Command Proxy <--> Instruments
// The medium between Instruments and Command Proxy is the command-proxy-client script.
// The format of the Command Proxy --> Instruments messages is {cmd:"<CMD>"}
// The format of the Instruments --> Command Proxy messages is:
// <one char message type>,<stringified json data>
// The json data in the message above has the following format:
// {status:<status>, value:<result>}

/* globals $, errors, env */

var commands;

(function () {
  var BOOTSTRAP_CONFIG_PREFIX = "setBootstrapConfig: ";
  var BIG_DATA_THRESHOLD = 50000;
  var MORE_COMMAND = "#more";
  var MESSAGE_TYPES = ['error','no data','regular','chunk','last chunk'];

  commands = {};
  var WAIT_FOR_DATA_TIMEOUT = 3600;
  var curAppiumCmdId = -1;

  function BigResult(_result) {
    this.result = _result;
    this.idx = 0;
    this.noMore = function () {
      return this.idx > this.result.length;
    };
    this.messageType = function () {
      return this.noMore()? MESSAGE_TYPES.indexOf('last chunk') :
        MESSAGE_TYPES.indexOf('chunk');
    };
    this.nextChunk = function () {
      var _this = this;
      var nextIdx = this.idx + BIG_DATA_THRESHOLD;
      var chunk = _this.result.substring(_this.idx, nextIdx);
      this.idx = nextIdx;
      return chunk;
    };
  }
  var bigResult = null;

  var prepareChunk = function (args) {
    var chunk = bigResult.nextChunk();
    args.push(bigResult.messageType() + ',' + chunk);
    if (bigResult.noMore()) bigResult = null;
  };

  var sendResultAndGetNext = function (result) {
    curAppiumCmdId++;
    var args = [env.commandProxyClientPath, '/tmp/instruments_sock'];
    if (typeof result !== "undefined") {
      if (result.type === 'chunk') {
        // we responded to the 'more' command
        prepareChunk(args);
      } else {
        var stringResult = JSON.stringify(result);
        if (stringResult.length < BIG_DATA_THRESHOLD){
          // regular small results
          args.push(MESSAGE_TYPES.indexOf('regular') + ',' +stringResult);
        } else {
          // initiating big result transfer
          bigResult = new BigResult(stringResult);
          prepareChunk(args);
        }
      }
    } else {
        args.push(MESSAGE_TYPES.indexOf('no data') + ',');
    }
    var cmd = env.nodePath + " " + args.join(" ");
    var cmdLog = cmd.slice(0, 300) + '...';
    var res;
    try {
      $.log("Running system command #" + curAppiumCmdId + ": " + cmdLog);
      res = $.system().performTaskWithPathArgumentsTimeout(env.nodePath, args, WAIT_FOR_DATA_TIMEOUT);
    } catch (e) {
      $.log(e.name + " error getting command " + curAppiumCmdId + ": " + e.message);
      return null;
    }
    if (!res) {
      $.log("Command proxy client (" + cmd + ") exited with null res");
      return null;
    }
    if (res.exitCode !== 0) {
      $.log("Command proxy client (" + cmd + ") exited with " + res.exitCode +
                  ", here's stdout:");
      $.log(res.stdout);
      return null;
    }
    var output = res.stdout.replace(/^(.*\n)*----- OUTPUT -----\r?\n/g,'');
    return JSON.parse(output).cmd;
  };

  var getFirstCommand = function () {
    return sendResultAndGetNext();
  };

  commands.startProcessing = function () {
    // let server know we're alive and get first command
    var cmd = getFirstCommand();

    while (true) {
      if (cmd) {
        var result;
        $.log("Got new command " + curAppiumCmdId + " from instruments: " + cmd);
        try {
          if (cmd.indexOf(BOOTSTRAP_CONFIG_PREFIX) === 0) {
            var configStr = cmd.slice(BOOTSTRAP_CONFIG_PREFIX.length);
            $.log("Got bootstrap config: " + configStr);
            eval(configStr);
          } else if (cmd === MORE_COMMAND) {
            result = {
              status: errors.Success.code,
              type: 'chunk',
            };
          } else {
            /* jshint evil:true */
            try {
              $.debug('evaluating ' + cmd);
              result = eval(cmd);
              $.debug('evaluation finished');
            } catch (possStaleEl) {
              if (possStaleEl.message === errors.StaleElementReference.code) {
                result = {
                  status: errors.StaleElementReference.code,
                  value: errors.StaleElementReference.summary
                };
              } else {
                throw possStaleEl;
              }
            }
          }
        } catch (e) {
          result = {
            status: errors.JavaScriptError.code
          , value: e.message
          };
        }
        if (typeof result === "undefined" || result === null) {
          result = '';
          $.log("Command executed without response");
        }
        if (typeof result.status === "undefined" || typeof result.status === "object") {
          $.log("Result is not protocol compliant, wrapping");
          result = {
            status: errors.Success.code,
            value: result
          };
        }
        cmd = sendResultAndGetNext(result);
      } else {
        throw new Error("Error getting next command, shutting down :-(");
      }
    }
  };
})();

