/* SPDX-License-Identifier: AGPL-3.0-only
 * hsrp-test: runs the phone core on a computer, for testing:  hsrp-test <port> <token> [web root] */
#include "hsrp.h"
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
static void lg(const char *l) { fprintf(stderr, "hsrp: %s\n", l); }
int main(int argc, char **argv)
{
	hsrp_set_log(lg);
	int p = hsrp_start(argc > 1 ? atoi(argv[1]) : 0, argc > 2 ? argv[2] : "test", argc > 3 ? argv[3] : "");
	printf("%d\n", p); fflush(stdout);
	if(p < 0) return 1;
	for(;;) sleep(60);
}
