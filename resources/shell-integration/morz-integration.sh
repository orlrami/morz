# morz-integration.sh — Morz shell integration for bash (WSL, best-effort).
# Loaded via `wsl.exe bash --init-file <this>`, which SKIPS ~/.bashrc — so we
# source it first, then layer OSC 133 block marks on top of whatever prompt
# the user configured.
#
# Marks emitted (signed with the Morz per-session nonce, then the env var is
# unset so children can never forge marks):
#   A prompt start · B command input start · D;<exit> command finished
# C (output start) is omitted on purpose: a correct bash preexec needs
# DEBUG-trap gymnastics that clobber $? — blocks render fine without it.

if [ -f "$HOME/.bashrc" ]; then
    . "$HOME/.bashrc"
fi

if [ -n "${MORZ_BLOCK_NONCE:-}" ] && [ -z "${__morz_nonce:-}" ]; then
    __morz_nonce="$MORZ_BLOCK_NONCE"
    unset MORZ_BLOCK_NONCE

    __morz_marks() {
        if [ -n "${__morz_ran:-}" ]; then
            printf '\033]133;D;%s;nonce=%s\007' "$__morz_ec" "$__morz_nonce"
        fi
        __morz_ran=1
        printf '\033]133;A;nonce=%s\007' "$__morz_nonce"
    }

    # Capture $? first, let any user PROMPT_COMMAND run, then emit marks last
    # so the A mark sits directly above the prompt row.
    PROMPT_COMMAND='__morz_ec=$?;'"${PROMPT_COMMAND:+$PROMPT_COMMAND;}"'__morz_marks'

    # Invisible (\[ \]) B mark appended to the prompt itself.
    PS1="${PS1}\\[\\033]133;B;nonce=${__morz_nonce}\\007\\]"
fi
