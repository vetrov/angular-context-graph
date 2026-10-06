import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter, Routes } from '@angular/router';
import { provideAppInitializer, makeEnvironmentProviders, Provider, inject } from '@angular/core';
import { Root, Leaf, guard, resolver, initializer } from './components';
import { WORK, OTHER, RootWorker, RouteWorker, rootProviders } from './tokens';
export const SHARED: Routes = [{ path: 'reused', component: Leaf }];
export const routes: Routes = [
	{
		path: 'lazy',
		loadComponent: () => import('./lazy').then((m) => m.LazyPage),
		providers: [{ provide: WORK, useClass: RouteWorker }],
		canActivate: [guard],
		resolve: { payload: resolver },
	},
	{ path: 'feature', loadChildren: () => import('./lazy').then((m) => m.LAZY_ROUTES) },
	{ path: 'module', loadChildren: () => import('./module').then((m) => m.LazyModule) },
	{ path: 'a', providers: [{ provide: WORK, useClass: RouteWorker }], children: SHARED },
	{ path: 'b', children: SHARED },
	{ path: '', pathMatch: 'full', redirectTo: 'lazy' },
	{
		path: 'opaque',
		loadComponent: () =>
			Math.random() > 0.5 ? import('./lazy').then((m) => m.LazyPage) : Promise.resolve(Leaf),
	},
	{ path: '**', component: Leaf },
];
const config = {
	providers: [
		makeEnvironmentProviders(rootProviders),
		provideAppInitializer(initializer),
		provideRouter(routes),
	],
};
bootstrapApplication(Root, config);
function opaqueProviders(): Provider[] {
	return [];
} // Contents intentionally opaque: do not execute.
bootstrapApplication(Root, {
	providers: [opaqueProviders(), { provide: OTHER, useClass: RootWorker }],
});
