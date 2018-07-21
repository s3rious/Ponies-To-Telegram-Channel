import intel from 'intel';

intel.config({
  formatters: {
    simple: {
      format: '[%(date)s] %(levelname)s: %(message)s',
      colorize: false
    },
  },
  handlers: {
    console: {
      class: intel.handlers.Console,
      formatter: 'simple',
      level: intel.VERBOSE
    },
    file: {
      class: intel.handlers.File,
      level: intel.VERBOSE,
      file: './logs/verbose.log',
      formatter: 'simple'
    }
  },
  loggers: {
    logger: {
      handlers: ['console', 'file'],
      level: intel.VERBOSE,
      handleExceptions: true,
      exitOnError: false,
      propagate: false
    }
  }
});

export const logger = intel.getLogger('logger');
