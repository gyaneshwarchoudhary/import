import { UserService } from '@/services/UserService'
import { ActionTree } from 'vuex'
import RootState from '@/store/RootState'
import UserState from './UserState'
import * as types from './mutation-types'
import { hasError, showToast } from '@/utils'
import { translate } from '@/i18n'
import { logout, updateInstanceUrl, updateToken, resetConfig } from '@/adapter'
import logger from "@/logger";
import { useAuthStore } from '@hotwax/dxp-components';
import emitter from '@/event-bus'

const actions: ActionTree<UserState, RootState> = {

  /**
 * Login user and return token
 */
  async login ({ commit, dispatch }, payload) {
    try {
      const { token, oms } = payload;
      dispatch("setUserInstanceUrl", oms);
      
      if (token) {
        const permissionId = process.env.VUE_APP_PERMISSION_ID;
        if (permissionId) {
          const checkPermissionResponse = await UserService.checkPermission({
            data: {
              permissionId
            },
            headers: {
              Authorization:  'Bearer ' + token,
              'Content-Type': 'application/json'
            }
          });

          if (checkPermissionResponse.status === 200 && !hasError(checkPermissionResponse) && checkPermissionResponse.data && checkPermissionResponse.data.hasPermission) {
            commit(types.USER_TOKEN_CHANGED, { newToken: token })
            updateToken(token)
            await dispatch('getProfile')
            dispatch('setPreferredDateTimeFormat', process.env.VUE_APP_DATE_FORMAT ? process.env.VUE_APP_DATE_FORMAT : 'MM/dd/yyyy');
          } else {
            const permissionError = 'You do not have permission to access the app.';
            showToast(translate(permissionError));
            logger.error("error", permissionError);
            return Promise.reject(new Error(permissionError));
          }
        } else {
          commit(types.USER_TOKEN_CHANGED, { newToken: token })
          updateToken(token)
          await dispatch('getProfile')
          dispatch('setPreferredDateTimeFormat', process.env.VUE_APP_DATE_FORMAT ? process.env.VUE_APP_DATE_FORMAT : 'MM/dd/yyyy');
        }
      }
    } catch (err: any) {
      showToast(translate('Something went wrong'));
      logger.error("error", err);
      return Promise.reject(new Error(err))
    }
    // return resp
  },

  /**
   * Logout user
   */
  async logout ({ commit }, payload) {
    // store the url on which we need to redirect the user after logout api completes in case of SSO enabled
    let redirectionUrl = ''

    emitter.emit('presentLoader', { message: 'Logging out', backdropDismiss: false })

    // Calling the logout api to flag the user as logged out, only when user is authorised
    // if the user is already unauthorised then not calling the logout api as it returns 401 again that results in a loop, thus there is no need to call logout api if the user is unauthorised
    if(!payload?.isUserUnauthorised) {
      let resp;

      // wrapping the parsing logic in try catch as in some case the logout api makes redirection, and then we are unable to parse the resp and thus the logout process halts
      try {
        resp = await logout();

        // Added logic to remove the `//` from the resp as in case of get request we are having the extra characters and in case of post we are having 403
        resp = JSON.parse(resp.startsWith('//') ? resp.replace('//', '') : resp)
      } catch(err) {
        logger.error('Error parsing data', err)
      }

      if(resp?.logoutAuthType == 'SAML2SSO') {
        redirectionUrl = resp.logoutUrl
      }
    }

    const authStore = useAuthStore()

    // TODO add any other tasks if need
    commit(types.USER_END_SESSION)
    resetConfig();
    this.dispatch('order/updatePurchaseOrders', {parsed: {}, original: {}, unidentifiedItems: []});
    this.dispatch('util/clearFacilities');
    // clearing field mappings and current mapping when the user logout
    commit(types.USER_FIELD_MAPPINGS_UPDATED, {})
    commit(types.USER_CURRENT_FIELD_MAPPING_UPDATED, {id: '', mappingType: '', name: '', value: {}})
    
    // reset plugin state on logout
    authStore.$reset()

    // If we get any url in logout api resp then we will redirect the user to the url
    if(redirectionUrl) {
      window.location.href = redirectionUrl
    }

    emitter.emit('dismissLoader')
    return redirectionUrl;
  },

  /**
   * Get User profile
   */
  async getProfile ( { commit, dispatch }) {
    const resp = await UserService.getProfile()
    if (resp.status === 200) {
      dispatch('getFieldMappings')
      commit(types.USER_INFO_UPDATED, resp.data);
    }
  },

  /**
   * update current facility information
   */
  async setFacility ({ commit }, payload) {
    commit(types.USER_CURRENT_FACILITY_UPDATED, payload.facility);
  },

  setPreferredDateTimeFormat ({ commit }, payload) {
    commit(types.USER_DATETIME_FORMAT_UPDATED, payload)
  },
  
  /**
   * Update user timeZone
   */
  async setUserTimeZone ( { state, commit }, payload) {
    const resp = await UserService.setUserTimeZone(payload)
    if (resp.status === 200 && !hasError(resp)) {
      const current: any = state.current;
      current.userTimeZone = payload.timeZoneId;
      commit(types.USER_INFO_UPDATED, current);
      showToast(translate("Time zone updated successfully"));
    }
  },

  /**
   * Set User Instance Url
   */
  setUserInstanceUrl ({ commit }, payload){
    commit(types.USER_INSTANCE_URL_UPDATED, payload)
    updateInstanceUrl(payload)
  }, 
  
  updatePwaState({commit}, payload) {
    commit(types.USER_PWA_STATE_UPDATED, payload);
  },

  async getFieldMappings({ commit }) {
    let fieldMappings = {} as any;
    try {
      const payload = {
        "inputFields": {
          "mappingPrefTypeEnumId": Object.values(JSON.parse(process.env.VUE_APP_MAPPING_TYPES as string)),
          "mappingPrefTypeEnumId_op": "in"
        },
        "fieldList": ["mappingPrefName", "mappingPrefId", "mappingPrefValue", "mappingPrefTypeEnumId"],
        "filterByDate": "Y",
        "viewSize": 20, // considered a user won't have more than 20 saved mappings
        "entityName": "DataManagerMapping"
      }

      const mappingTypes = JSON.parse(process.env.VUE_APP_MAPPING_TYPES as string)
      
      // This is needed as it would easy to get app name to categorize mappings
      const mappingTypesFlip = Object.keys(mappingTypes).reduce((mappingTypesFlip: any, mappingType) => {
        // Updating fieldMpaaings here in case the API fails 
        fieldMappings[mappingType] = {};
        mappingTypesFlip[mappingTypes[mappingType]] = mappingType;
        return mappingTypesFlip;
      }, {});

      const resp = await UserService.getFieldMappings(payload);
      if(resp.status == 200 && !hasError(resp) && resp.data.count > 0) {
        // updating the structure for mappings so as to directly store it in state
        fieldMappings = resp.data.docs.reduce((mappings: any, fieldMapping: any) => {
          const mappingType = mappingTypesFlip[fieldMapping.mappingPrefTypeEnumId]
          const mapping = mappings[mappingType];

          mapping[fieldMapping.mappingPrefId] = {
            name: fieldMapping.mappingPrefName,
            value: JSON.parse(fieldMapping.mappingPrefValue)
          }

          fieldMappings[mappingType] = mapping;
          return mappings;
        }, fieldMappings)

      } else {
        logger.error('error', 'No field mapping preference found')
      }
    } catch(err) {
      logger.error('error', err)
    }
    commit(types.USER_FIELD_MAPPINGS_UPDATED, fieldMappings)
  },

  async createFieldMapping({ commit }, payload) {
    try {

      const mappingTypes = JSON.parse(process.env.VUE_APP_MAPPING_TYPES as string)
      const mappingPrefTypeEnumId = mappingTypes[payload.mappingType];

      const params = {
        mappingPrefId: payload.id,
        mappingPrefName: payload.name,
        mappingPrefValue: JSON.stringify(payload.value),
        mappingPrefTypeEnumId
      }

      const resp = await UserService.createFieldMapping(params);

      if(resp.status == 200 && !hasError(resp)) {

        // using id coming from server, as the random generated id sent in payload is not set as mapping id
        // and an auto generated mapping from server is set as id
        const fieldMapping = {
          id: resp.data.mappingPrefId,
          name: payload.name,
          value: payload.value,
          type: payload.mappingType
        }

        commit(types.USER_FIELD_MAPPING_CREATED, fieldMapping)
        showToast(translate('This CSV mapping has been saved.'))
      } else {
        logger.error('error', 'Failed to save CSV mapping.')
        showToast(translate('Failed to save CSV mapping.'))
      }
    } catch(err) {
      logger.error('error', err)
      showToast(translate('Failed to save CSV mapping.'))
    }
  },

  async updateFieldMapping({ commit, state }, payload) {
    try {

      const mappingTypes = JSON.parse(process.env.VUE_APP_MAPPING_TYPES as string)
      const mappingPrefTypeEnumId = mappingTypes[payload.mappingType];

      const params = {
        mappingPrefId: payload.id,
        mappingPrefName: payload.name,
        mappingPrefValue: JSON.stringify(payload.value),
        mappingPrefTypeEnumId
      }

      const resp = await UserService.updateFieldMapping(params);

      if(resp.status == 200 && !hasError(resp)) {
        const mappings = JSON.parse(JSON.stringify(state.fieldMappings))

        mappings[payload.mappingType][payload.id] = {
          name: payload.name,
          value: payload.value
        }

        commit(types.USER_FIELD_MAPPINGS_UPDATED, mappings)
        showToast(translate('Changes to the CSV mapping has been saved.'))
      } else {
        logger.error('error', 'Failed to update CSV mapping.')
        showToast(translate('Failed to update CSV mapping.'))
      }
    } catch(err) {
      logger.error('error', err)
      showToast(translate('Failed to update CSV mapping.'))
    }
  },

  async deleteFieldMapping({ commit, state }, payload) {
    try {
      const resp = await UserService.deleteFieldMapping({
        'mappingPrefId': payload.id
      });

      if(resp.status == 200 && !hasError(resp)) {

        const mappings = JSON.parse(JSON.stringify(state.fieldMappings))
        delete mappings[payload.mappingType][payload.id]

        commit(types.USER_FIELD_MAPPINGS_UPDATED, mappings)
        commit(types.USER_CURRENT_FIELD_MAPPING_UPDATED, {
          id: '',
          mappingType: '',
          name: '',
          value: {}
        })
        showToast(translate('This CSV mapping has been deleted.'))
      } else {
        logger.error('error', 'Failed to delete CSV mapping.')
        showToast(translate('Failed to delete CSV mapping.'))
      }
    } catch(err) {
      logger.error('error', err)
      showToast(translate('Failed to delete CSV mapping.'))
    }
  },

  async updateCurrentMapping({ commit, state }, payload) {
    const currentMapping = {
      id: payload.id,
      mappingType: payload.mappingType,
      ...(state.fieldMappings as any)[payload.mappingType][payload.id]
    }
    commit(types.USER_CURRENT_FIELD_MAPPING_UPDATED, currentMapping)
  },
  async clearCurrentMapping({ commit }) {
    commit(types.USER_CURRENT_FIELD_MAPPING_UPDATED, {
      id: '',
      mappingType: '',
      name: '',
      value: {}
    })
  }
}

export default actions;